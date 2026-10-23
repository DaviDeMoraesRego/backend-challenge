# Automação de testes via Postman

Coleção **declarativa em JSON** (Postman Collection v2.1) com os testes embutidos nos
scripts `pm.test`, pronta para importar na UI do Postman ou executar por CLI com o
Newman. Não há dados fixos: cada execução gera `playerId`/`externalTransactionId`
novos com `{{$guid}}`, então pode rodar quantas vezes quiser sem limpar o banco.

| Arquivo | Papel |
|---|---|
| [`wagering.postman_collection.json`](wagering.postman_collection.json) | 8 pastas · 55 requests · 122 asserts |
| [`wagering.local.postman_environment.json`](wagering.local.postman_environment.json) | `baseUrl`, `keycloakUrl`, `sqsQueueUrl`, credenciais dos clients |

## Como usar

### 1. Stack no ar

```bash
docker compose up -d --no-build          # api-1:3001, api-2:3002, api-3:3003, keycloak:8080, localstack:4566
docker compose --profile tools run --rm migrate
curl -s localhost:3001/health/ready      # {"status":"ok","pg":"up","sqs":"up"}
```

### 2. Postman (UI)

1. *Import* → os dois JSONs desta pasta.
2. Selecione o environment **Wagering · Local (docker compose)** no canto superior direito.
3. Abra a collection → **Run** (Collection Runner). A ordem das pastas importa: é uma
   coleção **stateful** (cria wallet → movimenta → reconcilia → prova o SQS).

### 3. CLI (Newman)

```bash
bun run test:postman
# equivalente a:
bunx newman@6 run postman/wagering.postman_collection.json \
  -e postman/wagering.local.postman_environment.json --delay-request 500
```

`--delay-request 500` dá folga ao consumer SQS no passo de polling. Para validar outra
instância (multi-instância), sobrescreva a URL:

```bash
bunx newman@6 run postman/wagering.postman_collection.json \
  -e postman/wagering.local.postman_environment.json \
  --env-var baseUrl=http://localhost:3002 --delay-request 500
```

## Cobertura declarada na coleção

| Pasta | O que prova |
|---|---|
| `00 · Health & métricas` | `/health/live`, `/health/ready` (pg+sqs) e `/metrics` sem Bearer; séries de domínio expostas |
| `01 · Auth (Keycloak)` | client-credentials de `provider-a`, `provider-b`, `ops-admin`; escopos corretos; credencial inválida → 401 |
| `02 · Wallets` | `POST /wallets` 201 com `OPENING` atômico (version 2); duplicada 409; campo extra 400; sem token 401; `GET` 200/404 |
| `03 · Transações` | `BET` 201 → replay `idempotentReplay:true` → conflito de payload 409 → saldo insuficiente 422 → `LOSS` 201 sem mover saldo → `WIN` → `ROLLBACK` (valor divergente 422, sucesso 201) → `REFUND` (`INVALID_REFERENCE_KIND`, sucesso, `REVERSAL_ALREADY_APPLIED`, `REFERENCE_REQUIRED`, `PENDING_REFERENCE` 202) → `OPENING` externo 400 → moeda fora da allow-list 400 → `PLAYER_MISMATCH` 422 → `PROVIDER_MISMATCH` 403 → chave derivada sem header → consultas por id/external 200 e 404 |
| `04 · Ledger & reconciliação` | cursor opaco + página seguinte + cursor inválido 400; 6 lançamentos com 3 `CREDIT`/3 `DEBIT` (prova que `LOSS` e `PENDING_REFERENCE` não geram lançamento); Σ ledger == `wallet.balance`; reconciliação `consistent:true` |
| `05 · Tenancy` | token de outro provedor não enxerga a wallet (404) e não opera nela (422 `PROVIDER_MISMATCH`) |
| `06 · Cenário 2×80` | saldo 100 → 80 (PROCESSED, 20.00) → 80 (422 `INSUFFICIENT_FUNDS`, 20.00) → reconciliação consistente → ledger com exatamente 1 débito |
| `07 · SQS / LocalStack` | `SendMessage` FIFO na `wager-transactions.fifo` → polling até o consumer aplicar o débito → reenvio com a mesma `MessageDeduplicationId` não duplica → reconciliação final consistente |

Os asserts usam os contratos reais: `application/problem+json` (RFC 9457) com `code`
estável, `transactionStatus` no 422 de rejeição e `idempotentReplay` no replay.

## O que **não** está aqui

Paralelismo real (50 duplicatas em voo, 2×80 simultâneo, 100 wallets, crash/recovery)
não é expressável no runner do Postman — está coberto por:

```bash
bun run test:concurrency     # CC-01, CC-02, CC-03, CC-05 contra PostgreSQL real
bun run test:integration     # 33 cenários (schema, fluxo, HTTP, outbox/SQS)
```

## Troubleshooting

| Sintoma | Causa provável |
|---|---|
| `ECONNREFUSED 127.0.0.1:8081` (ou qualquer porta ≠ 3001/3002/3003) | **environment errado selecionado** — o `baseUrl` está apontando para outro serviço/projeto. Selecione `Wagering · Local (docker compose)` e confirme `baseUrl = http://localhost:3001` no canto superior direito do Postman |
| `ECONNREFUSED localhost:3001` | stack parada — `docker compose ps` e `docker compose up -d --no-build --wait` |
| `401 TOKEN_INVALID` em todos os requests autenticados | tokens expiram em 300s: a coleção renova no início; rode a pasta `01 · Auth` antes das demais |
| Falha no passo `SQS · aguardar processamento` | consumer sem papel `sqs-consumer` na instância ou `--delay-request` insuficiente |
| `404 WALLET_NOT_FOUND` em `03` | a wallet foi criada com outro `baseUrl`; reexecute a coleção inteira contra a mesma instância |

### Portas deste projeto

| Porta | Serviço | `baseUrl` válido? |
|---|---|---|
| **3001 / 3002 / 3003** | api-1 / api-2 / api-3 | ✅ sim |
| 3000 | Grafana (ou `bun run dev` fora do compose) | ❌ |
| 8080 | Keycloak (só `keycloakUrl`) | ❌ |
| 4566 | LocalStack / SQS (só `sqsEndpoint`/`sqsQueueUrl`) | ❌ |
| 9090 / 16686 / 4317-4318 | Prometheus / Jaeger / OTel | ❌ |

Diagnóstico rápido de conectividade (PowerShell/cmd/Git Bash):

```bash
curl -s -o NUL -w "3001=%{http_code}\n" http://localhost:3001/health/live   # esperado: 3001=200
curl -s -o NUL -w "8080=%{http_code}\n" http://localhost:8080/realms/jungle # esperado: 8080=200
```
