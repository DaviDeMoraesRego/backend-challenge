# Hardening de Segurança — Distributed Wagering Processor

Documento de referência dos controles de segurança implementados e das condições de
deploy em produção.

## 1. Controles implementados

| Área | Controle | Onde |
|------|----------|------|
| Lógica financeira | `REFUND` e `ROLLBACK` são mutuamente exclusivos quando a referência é uma `BET` (sem crédito duplicado) | [`wager-transaction.repository.ts`](../src/contexts/wagering/infrastructure/persistence/repositories/wager-transaction.repository.ts), [`submit-wager-transaction.ts`](../src/contexts/wagering/application/use-cases/submit-wager-transaction.ts) |
| Concorrência | `UPDATE wallets` com guarda otimista (`version`) e verificação de `rowCount` | [`wallet.repository.ts`](../src/contexts/wagering/infrastructure/persistence/repositories/wallet.repository.ts) |
| Tenancy | `wallets.provider_id` + adoção exclusiva na primeira operação; leituras filtradas por provedor | [`Migration...004`](../src/contexts/wagering/infrastructure/persistence/migrations/Migration20260101000004_wallet_provider_ownership.ts), [`tenant-scope.ts`](../src/contexts/wagering/infrastructure/http/tenant-scope.ts) |
| Autenticação | `provider_id` obrigatório para operar em nome de provedor; algoritmos JWT fixados (`RS256`) | [`jose-provider-identity.ts`](../src/contexts/wagering/infrastructure/auth/jose-provider-identity.ts) |
| Autorização | `realm_access.roles` não concede escopos (planos separados) | [`scopes.ts`](../src/contexts/wagering/infrastructure/auth/scopes.ts) |
| Idempotência | Chave sempre prefixada pelo provedor + validação de formato/tamanho do header | [`submit-wager-transaction.ts`](../src/contexts/wagering/application/use-cases/submit-wager-transaction.ts), [`schemas.ts`](../src/contexts/wagering/application/dto/schemas.ts) |
| Mensageria | Assinatura HMAC-SHA256 do envelope SQS (obrigatória em produção) | [`payload-signature.ts`](../src/contexts/wagering/infrastructure/messaging/payload-signature.ts) |
| Borda HTTP | `bodyLimit` de 16 KiB (413), helmet, rate limit 300 req/min por IP por instância, correlação sanitizada | [`main.ts`](../src/main.ts), [`request-context.middleware.ts`](../src/contexts/wagering/infrastructure/http/middleware/request-context.middleware.ts) |
| Persistência | Role da app sem `UPDATE`/`DELETE` no ledger; triggers de imutabilidade e constraints `DEFERRED` | [`infra/postgres/init.sql`](../infra/postgres/init.sql), [`Migration...001/002`](../src/contexts/wagering/infrastructure/persistence/migrations) |
| Observabilidade | `/metrics` protegido por bearer token quando `METRICS_AUTH_TOKEN` está definido; logs com redaction | [`metrics.controller.ts`](../src/contexts/wagering/infrastructure/observability/metrics/metrics.controller.ts), [`pino.factory.ts`](../src/contexts/wagering/infrastructure/observability/logging/pino.factory.ts) |
| Configuração | Validação fail-fast de produção (sem fault injection, sem auth desligada, sem segredos default) | [`env.ts`](../src/config/env.ts) |

Provas automatizadas: SEC-01…06/09/10 em [`test/security/keycloak.test.ts`](../test/security/keycloak.test.ts),
SEC-07/08 em [`test/security/jwt.test.ts`](../test/security/jwt.test.ts), assinatura do envelope em
[`test/security/sqs-signature.test.ts`](../test/security/sqs-signature.test.ts) e tenancy em
[`test/security/tenant-scope.test.ts`](../test/security/tenant-scope.test.ts).

## 2. Contrato de assinatura do envelope SQS

`signature` (nível raiz do envelope) = `HMAC_SHA256(secret, canonicalJson(data))` em hex.

- JSON canônico: chaves ordenadas, sem espaços, UTF-8.
- `data` é exatamente o objeto de negócio (`providerId`, `externalTransactionId`,
  `idempotencyKey`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`,
  `referenceExternalTransactionId?`).
- Mensagem com assinatura ausente/inválida vai direto para a DLQ (erro permanente),
  sem bloquear o message group FIFO.

## 3. Operação em produção

O processo **não sobe** com `NODE_ENV=production` se:

- `AUTH_ENABLED=false`
- `FAULT_INJECTION_ENABLED=true`
- `SQS_REQUIRE_SIGNATURE=false` ou `SQS_SIGNING_SECRET` vazio
- `METRICS_AUTH_TOKEN` vazio (< 16 chars)
- `DATABASE_URL` com credenciais padrão de desenvolvimento
- `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` = `test`
- `KEYCLOAK_ISSUER`/`KEYCLOAK_JWKS_URL` sem `https://`

Todos esses casos são exercitados em unidade pelo `superRefine` de
[`env.ts`](../src/config/env.ts).

## 4. Migrations e implantação

- Migrations rodam com a role `wagering_migrator` (owner): `bun run migrate:up`.
  A aplicação conecta com `wagering_app`, que não tem `UPDATE`/`DELETE` em
  `ledger_entries`/`journals`/`accounts`.
- Reversibilidade provada por teste (`migrate up → down → up` em base limpa, IT-INFRA-01,
  em [`test/integration/infra-health.test.ts`](../test/integration/infra-health.test.ts)).
- Ordem de deploy: (1) `postgres` saudável → (2) `migrate` (profile `tools`) →
  (3) instâncias da API. O boot não aplica migrations automaticamente, para evitar DDL
  concorrente entre as N instâncias.
- Segredos (senhas de DB, `SQS_SIGNING_SECRET`, `METRICS_AUTH_TOKEN`) vêm do orquestrador;
  os valores do compose são apenas de desenvolvimento.
