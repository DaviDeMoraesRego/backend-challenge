# Distributed Wagering Processor

Serviço financeiro distribuído para ingestão e liquidação de transações de apostas
(`BET → WIN | LOSS | REFUND | ROLLBACK`) recebidas de múltiplos provedores, construído
como **monólito modular** (Hexagonal + DDD tático) sobre **Bun + NestJS + PostgreSQL +
SQS (LocalStack)**, com idempotência persistente, partidas dobradas, outbox
transacional e o **banco como autoridade final** de consistência.

```
Provider ──HTTP──▶ AuthGuard(JWKS) ─▶ SubmitWagerTransaction ─┐
Provider ──SQS───▶ Inbox(consumer)  ─▶ (mesmo use case)       ├─▶ PostgreSQL
                                                              │   wallets · transactions
OutboxPublisher ──▶ wager-events.fifo                          │   journals · ledger(2 pernas)
PendingWorker · ReconciliationJob · RetentionJob ──────────────┘   inbox · outbox
```

## Stack

| Camada | Escolha |
|---|---|
| Runtime / package manager / test runner | **Bun 1.4** |
| Linguagem | **TypeScript** estrito (`strict: true`, sem `any` implícito) |
| Framework | **NestJS 10** com **Fastify** |
| Banco | **PostgreSQL 16** (roles `wagering_app` / `wagering_migrator`) |
| ORM | **MikroORM 6** como Unit of Work/pool/migrator + mappers explícitos (ver ADR-14) |
| Mensageria | **AWS SQS FIFO** via **LocalStack** (DLQ + redrive) |
| Auth | **Keycloak 26** (realm-as-code, client-credentials, JWKS via `jose`) |
| Observabilidade | **pino** + **prom-client** + **OpenTelemetry** (OTel Collector → Jaeger) + **Prometheus/Grafana** provisionados |
| Carga | **k6** |

## Quickstart

Pré-requisitos: **Docker** e **Bun ≥ 1.4** (o `bun.lock` é lockfileVersion 2).

```bash
bun install
docker compose up -d postgres localstack keycloak          # infra mínima
export DATABASE_URL_MIGRATOR=postgres://wagering_migrator:wagering_migrator@localhost:5432/wagering
bun run migrate:up
export AUTH_ENABLED=false                                   # auth simplificada em dev
export ROLE=api,sqs-consumer,outbox-publisher,pending-reference-worker,reconciliation-job,outbox-retention-job
bun run dev                                                 # http://localhost:3000
```

Stack completa (3 instâncias + observabilidade):

```bash
docker compose up -d --wait        # api-1:3001, api-2:3002, api-3:3003, jaeger:16686, grafana:3000, prometheus:9090
docker compose --profile tools run --rm migrate
```

> Se o `build` falhar com `additional privileges requested: pass "--allow=fs.read=Dockerfile"`
> (Bake no Docker Desktop recente), construa as imagens sem Bake e suba sem rebuild:
>
> ```bash
> docker build -t wagering-api-1 .
> docker tag wagering-api-1 wagering-api-2
> docker tag wagering-api-1 wagering-api-3
> docker tag wagering-api-1 wagering-migrate
> docker compose up -d --no-build --wait
> ```

### Token (Keycloak, client-credentials)

```bash
TOKEN=$(curl -s -X POST http://localhost:8080/realms/jungle/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret \
  | sed -E 's/.*"access_token":"([^"]+)".*/\1/')
```

### Exemplos

```bash
# criar wallet (ops-admin; sem AUTH pode ser provider-a)
curl -s -X POST localhost:3001/wallets -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# BET (idempotente)
curl -s -X POST localhost:3001/wagering/transactions \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123",
       "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
       "walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp",
       "kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'

# consultas
curl -s localhost:3001/wallets/<walletId> -H "Authorization: Bearer $TOKEN"
curl -s "localhost:3001/wallets/<walletId>/ledger?limit=10" -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:3001/wallets/<walletId>/reconciliation -H "Authorization: Bearer $TOKEN"
curl -s localhost:3001/health/ready      # aberto
curl -s localhost:3001/metrics           # aberto (Prometheus)
```

## Comandos

| Comando | Descrição |
|---|---|
| `bun run dev` | app em watch (papéis por `ROLE`) |
| `bun test` / `bun run test` | suíte de unidade (sem IO) |
| `bun run test:integration` | PostgreSQL + LocalStack reais (usa `TEST_DATABASE_URL`) |
| `bun run test:concurrency` | concorrência in-process contra PostgreSQL (50 duplicatas, 2×80, 100 wallets, reversão dupla) |
| `bun run test:system` | cluster real de **3 processos** (`Bun.spawn`): CC-04/06/07/08 + CR-01/02/02b/03/04 com fault injection |
| `bun run test:security` | JWT/JWKS local + **Keycloak real** (SEC-01…06, SEC-09/10) |
| `bun run test:observability` | métricas/logs/traces + Prometheus, Grafana e Jaeger reais (OBS-02…05, OBS-TRACE-01, IT-INFRA-02) |
| `bun run test:load` | k6 (cenários em `test/load/wager-load.js`; relatório em [`docs/load-test-report.md`](docs/load-test-report.md)) |
| `bun run test:postman` | coleção Postman/Newman E2E (HTTP + Keycloak + SQS) em [`postman/`](postman/) |
| `bun run lint` / `bun run lint:boundaries` | ESLint (+ regra anti-`number` em Money) e dependency-cruiser |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run migrate:up` / `migrate:down` / `migrate:fresh` | migrations versionadas e reversíveis |
| `bun run seed:dev` / `seed:load` | wallets de desenvolvimento/carga (com ledger consistente) |
| `bun run scripts/benchmark-triggers.ts` | IT-TRIG-01 (custo dos triggers deferred) |
| `bun run scripts/verify-invariants.ts` | auditoria manual: `saldo == Σ ledger`, Σ=0 por moeda, wallets órfãs |

> `test:system`, `test:security`, `test:observability` e `test:all` exigem a stack completa
> (`docker compose up -d --no-build --wait` + migrations): sobem processos reais e falam com
> Keycloak, LocalStack, Prometheus, Grafana e Jaeger. `test` e `test:concurrency` precisam
> apenas de PostgreSQL + LocalStack.

## Variáveis de ambiente

| Nome | Default | Descrição |
|---|---|---|
| `ROLE` | `api` | papéis separados por vírgula: `api`, `sqs-consumer`, `outbox-publisher`, `pending-reference-worker`, `reconciliation-job`, `outbox-retention-job` (aliases: `consumer`, `pending-worker`, `reconciliation`, `retention`) |
| `PORT` / `INSTANCE_ID` | `3000` / `local-1` | porta HTTP e identidade da instância |
| `DATABASE_URL` | `postgres://wagering_app:wagering_app@localhost:5432/wagering` | role da aplicação (sem UPDATE/DELETE no ledger) |
| `DATABASE_URL_MIGRATOR` | — | role owner usada pelas migrations |
| `PG_POOL_MAX` | `48` | pool por instância (`floor(PG_MAX_CONNECTIONS·0.8/N)`) |
| `SQS_ENDPOINT` | `http://localhost:4566` | LocalStack |
| `SQS_TRANSACTIONS_QUEUE_URL` / `SQS_TRANSACTIONS_DLQ_URL` | `…/wager-transactions(.fifo/-dlq.fifo)` | fila de comandos |
| `SQS_EVENTS_QUEUE_URL` | `…/wager-events.fifo` | eventos publicados pela outbox |
| `SQS_CONSUMER_CONCURRENCY` | `8` | mensagens em voo por instância |
| `AUTH_ENABLED` | `true` | `false` usa `DisabledProviderIdentity` (ponto de extensão explícito) |
| `KEYCLOAK_ISSUER` / `KEYCLOAK_JWKS_URL` / `KEYCLOAK_AUDIENCE` | realm `jungle` / `wagering-api` | validação do JWT |
| `SUPPORTED_CURRENCIES` | `BRL,USD` | allow-list de moedas (escala 2) |
| `PROVIDERS` | `provider-a,provider-b` | allow-list de provedores |
| `METRICS_ENABLED` / `OTEL_ENABLED` | `true` / `false` | `/metrics` e export OTLP |
| `LOCK_TIMEOUT_MS` / `STATEMENT_TIMEOUT_MS` / `TX_MAX_RETRIES` | `2000` / `10000` / `3` | timeouts e retry de SQLSTATE transitório |
| `OUTBOX_*`, `PENDING_*`, `RECONCILE_*`, `RETENTION_*` | ver `.env.example` | tunables dos workers |
| `FAULT_INJECTION_ENABLED` + `FAULT_*` | `false` | **somente testes** (crash após commit/publish, delay de lock) |

## Filas (LocalStack `infra/localstack/init.sh`)

| Fila | Atributos |
|---|---|
| `wager-transactions.fifo` | `ContentBasedDeduplication=false`, `VisibilityTimeout=45`, `ReceiveMessageWaitTimeSeconds=20`, retention 4d, redrive → DLQ `maxReceiveCount=5` |
| `wager-transactions-dlq.fifo` | retention 14d |
| `wager-events.fifo` | `VisibilityTimeout=30`, redrive → DLQ `maxReceiveCount=10` |
| `wager-events-dlq.fifo` | retention 14d |

Envelope de comando: `{messageId, type:"WagerTransactionRequested", occurredAt, data{…}}`.
Envelope de evento: `IntegrationEvent.toJSON()` com `MessageGroupId=aggregateId` e
`MessageDeduplicationId=eventId`.

## Runbook operacional

- **Mensagem na DLQ** (`dlq_messages_total` > 0): inspecione
  `aws --endpoint-url=http://localhost:4566 sqs receive-message --queue-url …/wager-transactions-dlq.fifo`;
  corrija o envelope e **reenvie** para a fila principal. Reprocessar é seguro: a inbox
  (`consumer_name, message_id`) e a `idempotency_key` impedem efeito duplo.
- **Evento envenenado na outbox** (`outbox_poison_total`): a linha fica com
  `published_at IS NULL` e `next_attempt_at = now() + 24h`. Investigue o payload,
  corrija o consumidor e force uma nova tentativa com
  `UPDATE outbox_messages SET next_attempt_at = now(), attempts = 0 WHERE id = '…'`
  (role que tenha permissão) — nunca delete a linha.
- **Divergência de reconciliação** (`reconciliation_divergences_total`): o sistema
  **não corrige**. Investigue com o próprio endpoint e com
  `SELECT * FROM ledger_entries WHERE wallet_id = '…' ORDER BY wallet_version, id`;
  qualquer ajuste precisa de lançamento compensatório auditado, nunca `UPDATE` de saldo.
- **PENDING_REFERENCE acumulado** (`pending_reference_backlog`): verifique se o
  provedor realmente enviou a referência; o worker aplica backoff exponencial e
  rejeita com `REFERENCE_NOT_FOUND` após 12 tentativas/24h.

## Endpoints

| Método | Rota | Escopo |
|---|---|---|
| `POST` | `/wallets` | `wallet:admin` |
| `GET` | `/wallets/:id` · `/wallets/:id/ledger` | `wallet:read` |
| `POST` | `/wagering/transactions` | `wager:submit` (+ `provider_id` == body) |
| `GET` | `/wagering/transactions/:id` · `/providers/:providerId/wagering/transactions/:externalId` | `wallet:read` |
| `POST` | `/wallets/:id/reconciliation` | `reconcile:run` |
| `GET` | `/health/live`, `/health/ready`, `/metrics` | público |

Erros seguem **RFC 9457** (`application/problem+json`) com `code` estável —
tabela completa em [`ARCHITECTURE.md`](ARCHITECTURE.md) §7.

## Testes: o que está provado

Toda suíte roda contra infraestrutura **real** (PostgreSQL, LocalStack, Keycloak, Jaeger);
mocks só em relógio/ids e no JWKS local de unidade. Toda suíte IT/CC/CR termina com
`wallet.balance == Σ ledger` + Σ=0 por moeda ([`assert-ledger.ts`](test/helpers/assert-ledger.ts)).

| Prova | ID | Suíte |
|---|---|---|
| `Money`/`Currency`, `Wallet`, `WagerTransaction`, tabela kind×referência, `failureCode`, cursor, canônico | UT-01…53 (57 testes) | [`test/unit`](test/unit) |
| Garantias **no schema** (CHECK, UNIQUE, imutabilidade, Σ=0 e saldo↔ledger deferidos) | IT-SCHEMA/LEDGER | [`schema.test.ts`](test/integration/schema.test.ts) |
| Contratos HTTP, status, RFC 9457, idempotência, cursor, reconciliação, health/metrics | IT-API | [`http.test.ts`](test/integration/http.test.ts) |
| Use cases contra PG real (OPENING, settlement, PENDING_REFERENCE, multi-moeda) | IT-SETTLE/CURR/PEND | [`flow.test.ts`](test/integration/flow.test.ts) |
| Outbox → SQS, consumer com inbox/dedup, DLQ explícita | IT-OUTBOX/SQS | [`messaging.test.ts`](test/integration/messaging.test.ts) |
| Rollback total após o ledger, isolamento de Identity Map, 50 duplicatas, replay de REJECTED/PENDING, NUMERIC round-trip, quebra de cadeia | IT-TX/IDEM/CURR/SCHEMA/RECON | [`atomicity.test.ts`](test/integration/atomicity.test.ts) |
| 2 publishers concorrentes (SKIP LOCKED), backoff e poison da outbox | IT-OUTBOX-03/04/05 | [`outbox.test.ts`](test/integration/outbox.test.ts) |
| Erro transitório com `ChangeMessageVisibility`, redrive nativo para DLQ, OPENING pela fila, provider inválido, shutdown com mensagem em voo | IT-SQS-03/04/06/07/08 | [`sqs-behavior.test.ts`](test/integration/sqs-behavior.test.ts) |
| Claims disjuntos do worker, retenção outbox/inbox, `migrate up→down→up`, grants, advisory lock e Σ=0 da varredura | IT-PEND/RET/INFRA/RECON-JOB | [`workers.test.ts`](test/integration/workers.test.ts), [`infra-health.test.ts`](test/integration/infra-health.test.ts) |
| **50 duplicatas**, **2×80**, 100 wallets, reversão dupla (in-process) | CC-01/02/03/05 | [`race.test.ts`](test/concurrency/race.test.ts) |
| **3 processos reais**: mix HTTP+SQS, 3 publishers, REFUND antes da BET, BRL+USD, SIGKILL+restart, queda de conexão do PG | CC-04/06/07/08, CR-03/04 | [`test/system/cluster.test.ts`](test/system/cluster.test.ts) |
| **Fault injection**: consumer morto após commit antes do ack, publisher após publish, lease órfão | CR-01/02/02b | [`test/system/crash.test.ts`](test/system/crash.test.ts) |
| Keycloak real: escopos, `PROVIDER_MISMATCH`, tenancy, 401/403, body 16 KiB → 413, SQLi tratada como dado | SEC-01…06/09/10 | [`keycloak.test.ts`](test/security/keycloak.test.ts) |
| JWT expirado/audiência/issuer/assinatura/rotação de `kid` | SEC-07/08 | [`jwt.test.ts`](test/security/jwt.test.ts) |
| `/metrics` completo, cardinalidade de labels, redaction de logs, gauges da outbox, Prometheus/Grafana, traces no Jaeger | OBS-02…05, OBS-TRACE-01, IT-INFRA-02 | [`test/observability`](test/observability) |
| **E2E importável** (55 requests · 122 asserts): ciclo completo, idempotência, ledger/reconciliação, tenancy, cenário 2×80 e consumer SQS | — | [`postman/`](postman/wagering.postman_collection.json) |
| Carga real com k6 (throughput, p50/p95/p99, conflitos, outbox lag) | LT | [`docs/load-test-report.md`](docs/load-test-report.md) |

## Limitações conhecidas

1. **Escala fixa 2** (`NUMERIC(19,2)`): moedas com expoente ≠ 2 (JPY, BHD) exigiriam
   evolução de schema.
2. **`/metrics` aberto** (decisão documentada) — proteção por rede; `METRICS_AUTH_TOKEN`
   fecha o endpoint quando definido.
3. **Rate limit por instância** (memória por processo), não cota global — exigiria Redis.
   Foi o teto observado no teste de carga (300 req/min por IP por instância).
4. **LocalStack ≠ AWS**: FIFO/dedup/redrive validados localmente; o relatório de carga
   não deve ser extrapolado para produção.
5. **Ordenação por agregado** na outbox é "alta probabilidade + segurança no consumidor"
   (`walletVersion`/`eventId`), não ordem total global.
6. **Comparação 1 vs 3 instâncias** do teste de carga não foi executada nesta rodada —
   o cluster ficou em 3 para exercitar publishers/consumers concorrentes. Registrado em
   [`docs/load-test-report.md`](docs/load-test-report.md).

## Documentação

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — decisões, trade-offs e limitações.
- [`docs/load-test-report.md`](docs/load-test-report.md) — teste de carga k6 (ambiente, metodologia, p50/p95/p99, invariantes).
- [`docs/trigger-benchmark.md`](docs/trigger-benchmark.md) — IT-TRIG-01 (overhead medido dos triggers deferidos).
- [`docs/security-hardening.md`](docs/security-hardening.md) — controles de segurança e contrato de assinatura do envelope.
- [`postman/README.md`](postman/README.md) — coleção Postman (JSON) + environment para validar o serviço por HTTP/SQS.
