# Arquitetura — Distributed Wagering Processor

Documento de decisões: as escolhas **efetivamente implementadas**, os **trade-offs
medidos** e as **limitações**. Fonte funcional: [`docs/README.md`](docs/README.md).

---

## 1. Visão e princípios

Invariantes globais (README §3): **nunca duplicar crédito/débito, nunca perder evento
confirmado, nunca permitir saldo negativo** — em qualquer combinação de duplicata,
entrega fora de ordem, concorrência entre instâncias e morte de processo.

Princípios que sustentaram todas as decisões:

1. **O PostgreSQL é a autoridade final.** SQS FIFO, inbox e outbox são otimizações;
   a correção vem de locks por wallet, índices únicos, `CHECK` e *constraint triggers*
   `DEFERRED`. Nenhuma garantia vive só em código de aplicação.
2. **Nada de rede dentro da transação.** A tx financeira só fala com o PostgreSQL
   (sem SQS, sem IdP, sem exporter de trace) — lock curto e previsível.
3. **Simplicidade sobre abstração.** Um único binário com papéis por env; sem
   barramento interno, sem CQRS, sem cache distribuído.
4. **Domínio puro.** `domain/**` não conhece Nest, ORM, AWS, HTTP. Provado por
   `bun run lint:boundaries` (0 violações em 125 módulos).

---

## 2. Arquitetura e boundaries

```
src/
├── config/            env (zod, fail-fast) + tokens de DI
├── shared/            pure utils (uuidv7, canonical JSON, cursor, clock)
├── contexts/wagering/
│   ├── domain/        Money, Currency, Wallet, WagerTransaction, Ledger (2 pernas),
│   │                  Inbox/Outbox, WagerSettlementService, eventos, failureCodes
│   ├── application/   portas + use cases (classes TS puras, sem @Injectable)
│   └── infrastructure/ persistence · messaging · workers · http · auth · observability
├── modules/           wiring Nest (Core global, domain-wiring global, HttpApi)
├── roles/             resolução de papéis por env
└── main.ts            bootstrap, papéis, graceful shutdown
```

| Camada | Pode importar | Proibido |
|---|---|---|
| `domain/**` | `domain`, `shared` | Nest, MikroORM, AWS, pino, `application`, `infrastructure` |
| `application/**` | `domain`, `shared`, portas próprias | `infrastructure`, `modules`, Nest, MikroORM, AWS |
| `infrastructure/**` | `application` (portas), `domain`, `shared`, libs | `modules`, `roles` |
| `modules`/`roles` | tudo (wiring) | — |

Enforcement: `.dependency-cruiser.cjs` (`no-domain-outward`, `no-application-framework`,
`no-framework-in-domain`, `persistence-does-not-import-http`, `no-cycles`) + ESLint com
`no-restricted-imports` e três regras locais: `TSNumberKeyword` proibido em
`domain/money/**` (restrição 1); interpolação (`${...}`) proibida em template literal
passado a `execute`/`raw`/`query`/`queryOne` (SQL sempre parametrizado — cobre os
métodos que os repositórios realmente usam); e `no-explicit-any` como **erro** em
`src/modules/**` (a ordem de `inject` é o único contrato das factories de DI).

> Nota: as factories de `wagering-domain-wiring.module.ts` tipam cada parâmetro com a
> porta correspondente (`TransactionRunner`, `Clock`, `IdGenerator`, …), de modo que o
> compilador valide o alinhamento entre construtor e `inject`.

### Papéis (um binário, `ROLE` por env)

`api` · `sqs-consumer` · `outbox-publisher` · `pending-reference-worker` ·
`reconciliation-job` · `outbox-retention-job`. O compose sobe **3 instâncias** com todos
os papéis; papéis de worker podem ser isolados por env sem mudar o binário. Health e
`/metrics` existem sempre (readiness do harness), controllers de negócio só com `api`.

---

## 3. Modelo de domínio

- **Money** (`decimal.js`, precisão 30): imutável, escala fixa 2, entrada como string
  decimal; rejeita `NaN`, `Infinity`, notação científica, vazio, >2 casas, magnitude
  acima de `NUMERIC(19,2)`. Nunca `number` (regra de lint).
- **Currency**: ISO-4217 validada contra allow-list em duas camadas (DTO → 400;
  fila/use case → `REJECTED UNSUPPORTED_CURRENCY` auditável).
- **Wallet** (raiz): `open` (saldo 0, `version 1`), `debit`/`credit` retornam o
  `WalletLegDraft` (é impossível mover saldo sem produzir a perna contábil) e
  incrementam `version` apenas quando o saldo muda.
- **WagerTransaction** (raiz): nasce `PENDING` (nunca commitada nesse estado),
  transições explícitas, terminais `PROCESSED`/`REJECTED`/`FAILED` (transicionar de
  terminal lança `InvalidTransactionStateError`), `resultingBalance` como *snapshot*
  para replay, `attempts`/`nextAttemptAt` para o worker.
- **Decisão `Wallet.open`/`version`**: `version` inicia em 1 com saldo 0 e a
  `OPENING` incrementa para 2 quando `initialBalance > 0` — mantém a regra
  "version incrementa somente quando o saldo muda" sem exceção na criação.

### Tabela kind × referência (implementada em `wager-settlement.service.ts`)

| kind | referência | resultado |
|---|---|---|
| `BET` | — | `PROCESSED` (débito) ou `REJECTED INSUFFICIENT_FUNDS` |
| `WIN` | opcional (`BET`) | `PROCESSED` (crédito); ref ausente/pendente → `PENDING_REFERENCE` |
| `LOSS` | — | `PROCESSED` sem lançamentos |
| `REFUND` | `BET PROCESSED` | `PROCESSED` (crédito); sem ref → `REJECTED REFERENCE_REQUIRED` |
| `ROLLBACK` | `BET`/`WIN`/`REFUND` | inverso da referência; saldo insuficiente → `REJECTED REVERSAL_INSUFFICIENT_FUNDS` |
| `OPENING` | — | rejeitado se externo; aceito apenas no caminho interno de abertura |

Regras de reversão: escopo (`wallet`, `player`, `moeda`, `rodada`) conferido antes de
valor; valor tem de ser igual ao da referência; uma referência não é revertida duas
vezes pelo mesmo kind (só reversões `PROCESSED` consomem o slot).

### `failureCode` (taxonomia estável)

`VALIDATION_FAILED`, `UNSUPPORTED_CURRENCY`, `CURRENCY_MISMATCH`, `UNKNOWN_PROVIDER`,
`WALLET_NOT_FOUND`, `PLAYER_MISMATCH`, `OPENING_NOT_ALLOWED`, `REFERENCE_REQUIRED`,
`REFERENCE_NOT_FOUND`, `REFERENCE_NOT_REVERSIBLE`, `REFERENCE_SCOPE_MISMATCH`,
`INVALID_REFERENCE_KIND`, `AMOUNT_MISMATCH`, `REVERSAL_ALREADY_APPLIED`,
`INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `IDEMPOTENCY_CONFLICT`,
`WALLET_ALREADY_EXISTS`, `INFRA_TEMPORARY`, `INTERNAL_INCONSISTENCY` — cada um com ação
sugerida (`FIX`/`RETRY`/`RETRY_LATER`/`GIVE_UP`) em
`domain/transaction/failure-code.ts`.

### Eventos

`IntegrationEvent<T>` abstrato (`eventId` UUIDv7, `aggregateId`, `correlationId`,
`causationId`, `occurredAt`, `version` no tipo, `data` sempre com `MoneyProps`):
`WagerTransactionProcessed` (inclui `LOSS` e `OPENING`), `WagerTransactionRejected`,
`WagerTransactionPendingReference`, `WalletBalanceChanged` (só quando o saldo muda).

---

## 4. Ledger de partidas dobradas

- `journals` (≤1 por transação) + `ledger_entries` com **duas pernas**: perna de wallet
  (`balance_before/after`, `wallet_version`) e perna de contrapartida em
  `PROVIDER_CLEARING:{providerId}:{currency}` ou `OPENING_EQUITY:{currency}`,
  **append-only, sem saldo materializado**.
- **Por que não é hot row**: a aplicação apenas faz `INSERT` (lazy,
  `ON CONFLICT DO NOTHING`) e `SELECT` em `accounts`; nenhuma linha de contrapartida é
  atualizada por transações de wallets distintas. O único lock de linha é a wallet.
- **Como o saldo da contrapartida é conhecido**: por agregação
  (`SUM` por direção em `ledger_entries`), usada só em reconciliação/auditoria.
- **Convenção de sinais**: `DEBIT` reduz o saldo da wallet, `CREDIT` aumenta; a
  contrapartida usa a direção oposta. Σ débitos = Σ créditos **por journal e moeda**,
  verificada por constraint trigger `DEFERRED`.
- **Imutabilidade**: triggers `BEFORE UPDATE/DELETE/TRUNCATE` (`P0001`) +
  `REVOKE UPDATE, DELETE, TRUNCATE` da role da aplicação (`42501`) — defense in depth.

---

## 5. Consistência e concorrência

### Estratégia escolhida: lock pessimista por wallet

`SELECT … FROM wallets WHERE id = $1 FOR UPDATE` + `CHECK (balance >= 0)` no schema.
Alternativas descartadas: optimistic com retry (tempestade de retries e reexecução de
regras em hot wallet) e update condicional (não produz ledger/estado `REJECTED` na
mesma instrução sem CTE complexa).

### Ordem canônica da transação (ADR-03)

1. `BEGIN` (READ COMMITTED) + `set_config` de `lock_timeout=2s`,
   `statement_timeout=10s`, `idle_in_transaction_session_timeout=15s`.
2. *(SQS)* claim do inbox `ON CONFLICT DO NOTHING RETURNING`.
3. Claim de idempotência: `INSERT … ON CONFLICT DO NOTHING` **sem target** (cobre o
   único de `idempotency_key` e o de `(provider_id, external_transaction_id)`).
   Conflito → `SELECT` → hash igual = **replay**; hash diferente = **409**.
4. `SELECT wallet FOR UPDATE` (único ponto de serialização).
5. Validações independentes de estado (provider, moeda, kind externo, wallet existente).
6. Resolução de referência (`SELECT` sem lock; estado terminal lido sob o lock da wallet).
7. `WagerSettlementService.settle()` (regras + as duas pernas).
8. Persistência atômica: `UPDATE wallets` → `INSERT journals` → 2× `INSERT ledger_entries`
   → `UPDATE wager_transactions` (status + snapshot).
9. `INSERT outbox_messages` (com `trace_context`).
10. *(SQS)* `UPDATE inbox_messages SET processed_at`.
11. `COMMIT`. Só então resposta HTTP / `DeleteMessage`.

### Hot wallet, deadlocks, pool

- Throughput de **uma** wallet é intrinsecamente serial (a invariante é a ordem dos
  débitos): a tx é curta (~10 statements + 2 triggers indexados), sem rede.
- **Deadlock é impossível por construção** entre settles: ordem global
  `(1) índice único de idempotência → (2) linha da wallet → (3) inserts`, e cada
  transação toca **uma** wallet. `40P01` continua tratado por retry como defesa.
- Pool: `floor(PG_MAX_CONNECTIONS·0.8 / N)`, default 48 por instância com
  `max_connections=200` e 3 instâncias; consumer com concorrência 8.

### Idempotência (ADR-04)

- Chave **global** `UNIQUE(idempotency_key)`; HTTP exige `Idempotency-Key` (default
  derivado `"{providerId}:{externalTransactionId}"`), SQS exige
  `data.idempotencyKey` (divergência do padrão → warning, key respeitada).
- `payloadHash` = SHA-256 de **JSON canônico** (chaves ordenadas, sem espaços) do
  subconjunto de negócio, com `amount` normalizado (`"25"` == `"25.00"`);
  header/`messageId`/`occurredAt` fora do hash.
- Replay reconstrói a resposta **apenas de colunas persistidas**
  (`status`, `resulting_balance_amount/currency`, `failure_code`, `processed_at`),
  garantindo "mesmo saldo observado no momento original".
- Duplicatas concorrentes **esperam** no índice único e recebem replay (não 409
  espúrio) — trade-off deliberado.

### SQLSTATEs e retry

Retry **da transação inteira** apenas para `40001`, `40P01`, `55P03`, `08xxx`, `57P01`
(25/75/200 ms + jitter). `23505`/`23514` **não** são retentados: são bug/invariante
violada → erro ruidoso (`500`/`FAILED`).

---

## 6. Mensageria e recuperação

- **Consumer próprio** (`SqsPoller`): long polling, `MaxNumberOfMessages` limitado pela
  concorrência livre, ack **somente após commit**, 3 classes de erro
  (negócio → ack; transitório → `ChangeMessageVisibility` com backoff
  `min(2^n·2s, 60s)`; permanente → **DLQ explícita** + ack, liberando o message group).
- **Inbox persistente** `(consumer_name, message_id)`: dedup de redelivery
  independente da idempotência financeira.
- **Graceful shutdown**: `SIGTERM` → para de receber → espera handlers em voo até
  `SHUTDOWN_GRACE_MS` (25s) → `ChangeMessageVisibility(0)` para o que restou → fecha pool.
- **Outbox**: claim em tx curta com **lease** (`next_attempt_at = now() + 30s`,
  `FOR UPDATE SKIP LOCKED`), publicação **fora** da transação, marca/backoff em tx curta;
  `attempts >= 25` → poison (`next_attempt_at = now() + 24h`, métrica e log, sem descarte).
  Destino `wager-events.fifo` com `MessageGroupId=aggregateId` e
  `MessageDeduplicationId=eventId` (crash entre publish e mark ⇒ republicação segura).
- **PENDING_REFERENCE**: sweep a cada 2s com claim `SKIP LOCKED` + lease 60s, backoff
  `min(2^n·5s, 30min)` + jitter, TTL 12 tentativas/24h → `REJECTED REFERENCE_NOT_FOUND`;
  gatilho oportunista (pós-commit, fire-and-forget) reduz a latência para milissegundos.
- **Retenção**: DELETE em lotes por `ctid` — outbox publicada > 7d, inbox processada
  > 14d (14d > janela máxima de redelivery: retention 4d + backoff + margem).

---

## 7. API

Contratos, tabela de status e RFC 9457 (`application/problem+json`) conforme o
desafio (`docs/README.md` §9). Destaques da implementação:

| Situação | Status | `code` |
|---|---|---|
| shape inválido / campo desconhecido / moeda fora da allow-list / cursor inválido | 400 | `VALIDATION_FAILED` / `UNSUPPORTED_CURRENCY` / `INVALID_CURSOR` |
| token ausente/inválido/expirado | 401 | `TOKEN_INVALID` / `TOKEN_EXPIRED` (+ `WWW-Authenticate`) |
| escopo insuficiente / claim ≠ body | 403 | `INSUFFICIENT_SCOPE` / `PROVIDER_MISMATCH` |
| recurso inexistente em consulta | 404 | `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` |
| wallet duplicada / key com payload divergente | 409 | `WALLET_ALREADY_EXISTS` / `IDEMPOTENCY_CONFLICT` |
| rejeição de negócio persistida | 422 | o próprio `failureCode` |
| aceite pendente (`PENDING_REFERENCE`) | 202 | — |
| processado (`PROCESSED`, inclui `LOSS`) | 201 | — |
| infra transitória após retries | 503 | `INFRA_TEMPORARY` + `Retry-After: 1` |
| erro inesperado | 500 | `INTERNAL_ERROR` (sem stack/SQL) |

Corpo `422` carrega **os dois mundos**: campos do RFC 9457 (`type`, `title`, `status`,
`detail`, `instance`, `code`, `traceId`) **e** o envelope da transação
(`transactionId`, `transactionStatus`, `balance`, `failureCode`, `idempotentReplay`) —
assim o replay devolve corpo idêntico sem colidir com o campo `status` do problema.

Cursor do ledger: base64url opaco de `{v: walletVersion, i: entryId}`, paginação por
`(wallet_version, id)` (índice único dedicado ⇒ estável sob inserts; sem drift).

---

## 8. Reconciliação (sem autocorreção)

- **Endpoint** `POST /wallets/:id/reconciliation`: uma agregação
  (`SUM(CASE direction …)`) + `COUNT(*)` + verificação de cadeia
  (`LAG(balance_after) OVER (ORDER BY wallet_version, id)`); divergência →
  `consistent:false`, log `error` e `reconciliation_divergences_total`. **Nunca corrige**.
- **Job** (`reconciliation-job`): `pg_try_advisory_xact_lock(hashtext('wagering-reconciliation'))`
  para exclusividade multi-instância (lock de varredura, nunca de dados), lotes keyset
  de 500 wallets com agregação `ANY(...)`, e verificação de **Σ=0 por moeda**
  (`journals ⨝ ledger_entries GROUP BY currency`).
- Custo: I/O-bound por lote, fora do caminho quente; a verificação de cadeia por wallet
  é O(entradas da wallet) e roda sob demanda/drill-down.

---

## 9. Segurança

- **Keycloak 26** com realm-as-code (`infra/keycloak/realm-jungle.json`): realm
  `jungle`, audience `wagering-api`, client scopes `wager:submit`, `wallet:read`,
  `wallet:admin`, `reconcile:run`; clients `provider-a`/`provider-b` (service account +
  claim fixo `provider_id`) e `ops-admin`; `accessTokenLifespan=300s`.
- **Validação**: `jose.createRemoteJWKSet` (cache 10 min, cooldown 30s para rotação) +
  `jwtVerify(issuer, audience)`. Erros mapeados para `TOKEN_EXPIRED`/`TOKEN_INVALID`;
  escopo ausente → 403 com `WWW-Authenticate: … error="insufficient_scope"`;
  `provider_id` ≠ `providerId` do body/path → 403 `PROVIDER_MISMATCH`.
- **SQS** é canal interno confiável (sem JWT), mas a identidade do provedor na mensagem
  passa pela mesma validação de domínio (`PROVIDERS` allow-list → `UNKNOWN_PROVIDER`).
- **Hardening**: `bodyLimit 16 KiB`, helmet (CSP off para API JSON), rate limit
  `300 req/min` por IP **por instância** (mitigação, não cota), zod `.strict()` em todos
  os DTOs, `x-correlation-id` sanitizado (`^[A-Za-z0-9-]{8,64}$`), pino com `redact` de
  `authorization`/payloads financeiros, SQL 100% parametrizado, roles de banco com
  mínimo privilégio, Dockerfile multi-stage rodando como `bun` (non-root).
- **Escopo negativo explícito (não construído)**: login UI, ROPC, refresh tokens,
  gestão de usuários/RBAC dinâmico, introspecção/revogação, mTLS, auth em `/metrics`.

---

## 10. Observabilidade

- **Logs** (pino, JSON) com `correlationId`, `traceId`, `spanId`, `role`, `instanceId`,
  e contexto de negócio (`messageId`, `transactionId`, `walletId`, `providerId`) via
  **AsyncLocalStorage** (funciona igual em HTTP e no handler SQS; nenhum provider
  request-scoped).
- **Métricas** (prom-client, `/metrics`): `http_request_duration_seconds`,
  `wager_transactions_total{kind,status,provider}`, `wager_duplicates_total{type,channel}`,
  `sqs_messages_total{queue,result}`, `sqs_processing_duration_seconds`,
  `sqs_inflight`, `dlq_messages_total`, `db_transaction_retries_total{sqlstate}`,
  `db_lock_conflicts_total{sqlstate}`, `outbox_lag_seconds`, `outbox_backlog`,
  `outbox_publish_attempts_total{result}`, `pending_reference_backlog`,
  `pending_reference_retries_total`, `reconciliation_divergences_total{source}`,
  `reconciliation_checked_entries_total`, `retention_deleted_total{table}`,
  `pg_pool_*`. **Proibido** em label: `walletId`, `playerId`, `transactionId`, `messageId`.
- **Traces** (OTel, instrumentação manual `Tracer.withSpan`/`withRemoteSpan`):
  `http.submit` → `usecase.submit` → `db.tx` → outbox enqueue (`propagation.inject` →
  coluna `trace_context`) → `outbox.publish` (extract + inject em `MessageAttributes`) →
  `sqs.process`. Export OTLP → Collector → Jaeger. Se o SDK não carregar no runtime, o
  `NoopTracer` mantém o contrato (fallback pré-decidido).
- **Compose**: `otel-collector`, `jaeger`, `prometheus` (scrape das 3 instâncias) e
  `grafana` com datasources + dashboard **provisionados como código**
  (`infra/grafana/provisioning/dashboards/wagering-overview.json`: throughput, latência
  p50/p95/p99 HTTP e SQS, duplicatas, retries, DLQ, lock conflicts, outbox lag/backlog,
  reconciliação, saturação, up por instância).
- **`/metrics` aberto** (sem JWT) — decisão: labels de baixa cardinalidade, scrape sem
  gestão de token de serviço, proteção real por rede; `METRICS_ENABLED=false` desliga.

---

## 11. ADRs

As decisões estruturais estão nos capítulos acima (§2–§10). Dois pontos exigiram
solução diferente do desenho inicial e ficam registrados aqui como ADRs.

### ADR-14 · Mapeamento ORM: registros planos + mappers sobre SQL parametrizado

**Contexto.** O plano previa `EntitySchema` para hidratar registros via MikroORM. Durante
o spike (Fase 0) dois fatos apareceram: (a) o driver do MikroORM compila SQL via **knex**,
então placeholders `$n` não são vinculados (só `?`), e arrays em `ANY($1)` são expandidos
em bindings múltiplos; (b) `timestamptz` é devolvido como **string**, e `NUMERIC`/`BIGINT`
exigiriam conversões explícitas de qualquer forma.

**Decisão.** MikroORM permanece como **Unit of Work/pool/migrator**
(`em.fork().transactional()`, `em.getTransactionContext()`), mas o mapeamento é feito por
**mappers explícitos** (`records.ts` + `mappers.ts`) sobre SQL parametrizado com
placeholders `$1…$n` traduzidos para o dialeto do knex (`translatePlaceholders`).

**Alternativas.** (a) reescrever todo o SQL em `?` — perde legibilidade e permite erro de
ordem em placeholders repetidos; (b) usar o pool `pg` direto — perde a propagação do
`transactionContext`, quebrando a atomicidade real (os triggers `DEFERRED` passariam a
avaliar cada statement isolado); (c) mapear entidades com decorators — conflita com
construtores privados e força ORM no domínio.

**Trade-offs.** Um pouco mais de código de mapeamento (~200 linhas triviais) e disciplina
de conversão de tipos; em troca, domínio 100% puro, SQL auditável e semântica
transacional provada (o bug de autocommit foi descoberto justamente por um teste de
integração que esperava `23514` no commit).

**Validação.** `test/integration/flow.test.ts`, `test/integration/schema.test.ts`,
`test/integration/messaging.test.ts`, `test/concurrency/race.test.ts`.

### ADR-15 · Rejeição por `REFERENCE_REQUIRED` é persistida (não exceção)

**Contexto.** O README §6.3 diz que `create()` valida a exigência de referência; o
README §7 exige que a rejeição seja **persistida** com `failureCode` — ou seja, precisa
existir uma linha auditável.

**Decisão.** `WagerTransaction.create()` aceita a ausência de referência (guardando
`referenceExternalTransactionId` indefinido) e o `WagerSettlementService` devolve
`REJECTED REFERENCE_REQUIRED`, persistido com snapshot do saldo. O `CHECK`
`ck_wtx_reference_kind` permite `PENDING`/`REJECTED` sem referência, coerente com
"PENDING nunca é commitado".

**Trade-off.** A validação "por kind" deixa de ser exceção na factory e passa a ser uma
decisão auditável do settlement — ganho de auditabilidade (linha + evento
`WagerTransactionRejected`) sem perder o invariante.

**Validação.** UT de settlement (`REFUND/ROLLBACK sem referência`) e IT que verifica a
linha `REJECTED` com `failure_code` e snapshot.

---

## 12. Trade-offs e custos medidos

| Decisão | Custo medido / observação |
|---|---|
| Triggers `DEFERRED` (Σ=0 e saldo↔ledger) | **+0,4% em p95** (25,01 ms vs 24,90 ms; n=200 por lote) — mantidos. Ver [`docs/trigger-benchmark.md`](docs/trigger-benchmark.md) |
| Lock pessimista por wallet | 2×80 concorrentes: 1 `PROCESSED` + 1 `REJECTED INSUFFICIENT_FUNDS`, saldo `20.00`, **1** débito (CC-02) |
| Índice único como "lock" de idempotência | 50 duplicatas paralelas → 1 `PROCESSED`, 49 replays, **1** débito (CC-01) |
| READ COMMITTED + locks explícitos | sem `40001` espúrio; `SERIALIZABLE` rejeitado por custo de retry sem ganho |
| Mappers explícitos (ADR-14) | +200 linhas triviais; atomicidade real e domínio puro |
| Duplicatas de publicação na outbox | esperadas (crash entre publish e mark) e neutralizadas por `MessageDeduplicationId=eventId` + inbox |
| Sem auto-instrumentation OTel | spans manuais nos pontos de fronteira; fallback no-op se o SDK falhar |

---

## 13. Limitações conhecidas e trabalho futuro

1. **Escala fixa 2**: `NUMERIC(19,2)` + `Money` com `toFixed(2)`; JPY (0) e BHD (3) fora.
2. **Ordenação da outbox por agregado** é garantia "de alta probabilidade" no broker,
   com ordenação **garantida** no consumidor (`walletVersion`, `eventId`).
3. **`/metrics` sem auth** e **rate limit por instância** (memória): cota exata exigiria
   Redis/API gateway.
4. **Retenção** usa DELETE em lotes (não particionamento): simples e auditável, mas não é
   a solução para volumes muito maiores.
5. **Hot wallet** é serial por desenho; sharding por wallet/valor é trabalho futuro e
   mudaria a semântica de ordenação.
6. **Consumer de eventos externo** (a partir de `wager-events.fifo`) está fora de escopo —
   só o contrato de publicação e a dedup são garantidos.
7. **k6 não executado neste ambiente** (binário indisponível): o script e o template de
   relatório estão prontos, mas não há números de carga para reportar —
   ver [`docs/load-test-report.md`](docs/load-test-report.md).
8. **Suíte de crash com 3 processos não automatizada.** As flags de fault injection
   existem no código (`FAULT_CRASH_AFTER_COMMIT_BEFORE_ACK` no `SqsPoller`,
   `FAULT_CRASH_AFTER_PUBLISH_BEFORE_MARK`/`FAULT_CRASH_AFTER_CLAIM_OUTBOX` no
   `OutboxPublisher`, `FAULT_DELAY_LOCK_MS` no `TransactionRunner`), mas o harness
   `Bun.spawn` × 3 instâncias + `--repeat=10` (CR-01…CR-04, CC-04/06/07) **não** foi
   implementado nesta entrega. O efeito equivalente é provado indiretamente por
   IT-SQS-01/02 (redelivery → dedup por inbox → ack, sem efeito duplo) e por
   IT-OUTBOX-01/02/06 (claim com lease + dedup por `eventId`).
9. **Keycloak real não exercitado em teste automatizado.** O realm está como código e a
   validação JWT/JWKS é provada com JWKS local (SEC-07/08); SEC-01…06 (token real,
   escopo, provider mismatch) precisam do `docker compose` com Keycloak no ar.

---

## 14. Matriz de rastreabilidade final

| Requisito (README) | Componente implementado | Prova |
|---|---|---|
| R-01 `Money` exato (§6.1) | `domain/money/money.ts` (decimal.js) + lint anti-`number` | UT-01…08 |
| R-02 `Wallet` + invariantes (§6.2) | `domain/wallet/wallet.ts` + `wallets` CHECK/UNIQUE | UT-09…14, IT-SCHEMA-01/02 |
| R-03 `WagerTransaction` + estados (§6.3) | `domain/transaction/*` | UT-15…20 |
| R-04 ledger imutável, ≤1 lançamento/wallet/tx (§6.4) | `domain/ledger/*` + triggers + `uq_leg_wallet_tx` | UT-23/24, IT-LEDGER-02/03/06 |
| R-05 inbox/outbox na mesma tx (§6.5) | `application/ports`, `persistence/repositories` | IT-SETTLE-01, IT-OUTBOX-01 |
| R-06/R-07 regras BET/WIN/LOSS/REFUND/ROLLBACK (§7) | `WagerSettlementService` + `SubmitWagerTransaction` | UT-21…46, IT-SETTLE-01/02/03 |
| R-08 `PENDING_REFERENCE` + worker (§7.1) | `SettleWagerTransaction`, `PendingReferenceWorker`, gatilho oportunista | IT-PEND-01/02/03 |
| R-09 `failureCode` estável (§7.2) | `domain/transaction/failure-code.ts` | UT-47, IT-API (422) |
| R-10 concorrência por wallet (§8) | lock `FOR UPDATE` + CHECK + retry SQLSTATE | CC-01/02/03/05 |
| R-11 `POST /wallets` com OPENING (§9) | `OpenWallet` + `WalletController` | IT-API-01/02, HTTP |
| R-12 consultas + cursor (§9) | `queries.ts`, `shared/cursor.ts` | UT-53, HTTP (ledger/cursor), IT-API-04/05 |
| R-13 submit idempotente (§9) | `SubmitWagerTransaction` + `ProblemDetailsFilter` | UT-52, IT-IDEM-01/03, CC-01, HTTP (replay/409) |
| R-14 reconciliação sem autocorreção (§9) | `ReconcileWallet`, `ReconciliationJob` | IT-RECON-01/02 (endpoint) |
| R-15 health live/ready (§9) | `HealthController`, `ReadinessProbeImpl` | HTTP (health), IT-SCHEMA (indireto) |
| R-16 consumer SQS (§10) | `SqsPoller`, `error-classifier` | IT-SQS-01/02/05 (LocalStack real) |
| R-17 outbox multi-publisher (§11) | `claimDue` (SKIP LOCKED + lease), `OutboxPublisher` | IT-OUTBOX-01/02/06 |
| R-18 envelope + 4 eventos (§11) | `domain/events/*` | UT-48/49/50 |
| R-19 logs/métricas/health (§12) | `observability/*` | HTTP (`/metrics`), OBS unit (redaction) |
| R-20 testes §13 | `test/**` + `assertLedgerMatchesBalance` | todas as suítes |
| R-21 IdP externo (§2) | Keycloak realm-as-code + `JoseProviderIdentityAdapter` + `AuthGuard` | SEC-07/08 + HTTP com `AUTH_ENABLED=false` |
| R-22 Compose + migrations reversíveis (§4) | `docker-compose.yml`, `infra/`, `migrations/*` (up/down/fresh) | `bun run migrate:up` em PG 16.4 real, `migrate:fresh` |

**Self-review das restrições invioláveis (README §5)**: (1) `number` proibido por lint e
`Money` usa Decimal ✅ · (2) idempotência apenas no PG (índice único) ✅ · (3) nenhuma
garantia depende de FIFO (tudo no schema) ✅ · (4) evento só existe via outbox na mesma tx ✅ ·
(5) ledger imutável por trigger + REVOKE ✅ · (6) nenhum lock global (contrapartida
append-only, sem hot row) ✅ · (7) saldo só muda sob `FOR UPDATE` + CHECK ✅ ·
(8) correto com N instâncias (claims `SKIP LOCKED`, advisory lock, suíte CC) ✅ ·
(9) garantias no schema (CHECK/UNIQUE/FK/triggers DEFERRED/roles) — todas provadas por
`test/integration/schema.test.ts` contra PostgreSQL real ✅
