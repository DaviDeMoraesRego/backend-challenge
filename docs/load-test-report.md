# Relatório de Teste de Carga — Distributed Wagering Processor

Execução real com **k6 0.54** em Docker Compose, contra o cluster de **3 instâncias**
(`api-1:3001`, `api-2:3002`, `api-3:3003`) com PostgreSQL 16, LocalStack e Keycloak
reais. Sem meta de RPS: os números abaixo são **medidos**, com as limitações do
ambiente declaradas.

## 1. Ambiente

| Item | Valor |
|---|---|
| Host | Windows 11 + Docker Desktop (WSL2), 3 processos de app em containers |
| Runtime | Bun 1.4.3 |
| PostgreSQL | 16.4-alpine, `max_connections=200`, pool 48/instância |
| LocalStack | 3.8.1 (SQS FIFO + DLQ) |
| Keycloak | 26.0.5 (realm `jungle`, client-credentials) |
| k6 | grafana/k6:0.54.0 (container `k6`, profile `load`) |
| App | 3 × `ROLE=api,sqs-consumer,outbox-publisher,pending-reference-worker,reconciliation-job,outbox-retention-job` |
| Pré-carga | 50 wallets criadas pelo próprio `setup()` do script (saldo `100000.00` BRL) |

## 2. Metodologia

`test/load/wager-load.js` é autocontido: `setup()` obtém tokens reais (ops-admin e
provider-a) e cria as wallets via HTTP; os cenários distribuem as requisições
round-robin entre as 3 instâncias (`TARGETS`).

| Cenário | Executor | Carga | Duração |
|---|---|---|---|
| `distinct_wallets` | ramping-arrival-rate | 4 → 6 → 10 → 12 it/s | 60s |
| `hot_wallet` | constant-vus | 3 VUs, 1 wallet, `sleep 0.2` | 30s (a partir de 61s) |
| `duplicate_storm` | constant-vus | 1 VU, mesma key/rodada, 3 tentativas/iteração | 20s (a partir de 92s) |

Total: **1m53.7s**, 966 iterações completas, 0 interrompidas.

**Achado da primeira execução (descartada):** com ramping até 60 it/s o
`http_req_failed` passou de 53% — a causa foi o **rate limit de borda (300 req/min por
IP por instância**, limitação já documentada no README). Os cenários foram reduzidos
para ficarem **abaixo** do teto, medindo o caminho financeiro em vez do 429.

## 3. Resultados — 3 instâncias (execução final)

| Métrica (k6) | Valor |
|---|---|
| Throughput de submissão | **11,8 req/s** (12,0 it/s no pico do ramping) |
| Transações processadas (métrica do app) | 11,35/s |
| Latência HTTP — média | 33,5 ms |
| Latência HTTP — mediana | 25,6 ms |
| Latência HTTP — p90 / p95 | 33,7 ms / **39,5 ms** |
| Latência HTTP — máximo | 5,34 s (pico isolado durante o hot wallet) |
| `http_req_failed` (global) | 13,85% (186/1342) — **integralmente** do `duplicate_storm`, que devolve 409/422 por design |
| `http_req_failed{scenario:hot_wallet}` | **0%** |
| Replays idempotentes observados | 4 |
| Thresholds | ✅ aprovados (`p(95)<1500ms` e `rate<0.05` nos cenários de caminho feliz) |

### Métricas do Prometheus (janelas de 10–15 min, coletadas ao fim)

| Métrica | Valor |
|---|---|
| `histogram_quantile(0.50, http_request_duration_seconds)` | 23,3 ms |
| `histogram_quantile(0.99, http_request_duration_seconds)` | **83,4 ms** |
| `db_lock_conflicts_total` (aumento) | 19 |
| `db_transaction_retries_total` (aumento) | 19 |
| `wager_duplicates_total` (aumento) | 496 |
| `outbox_lag_seconds` (máx) | **0** |
| `outbox_backlog` (máx) | **0** |
| `dlq_messages_total` | 0 (nenhuma série positiva) |

Os conflitos de lock e retries do `TransactionRunner` aparecem exatamente na mesma
proporção: são as disputas da *hot wallet*, serializadas pelo `SELECT … FOR UPDATE` e
resolvidas pelo retry de SQLSTATE transitório — o comportamento esperado do desenho.

## 4. Invariantes pós-carga (`scripts/verify-invariants.ts`)

| Verificação | Resultado |
|---|---|
| `wallet.balance == Σ ledger` | **0 divergências** |
| Σ=0 por moeda (partida dobrada) | BRL `0.00`, USD `0.00` |
| Wallets sem ledger | 0 |
| Totais | 615 wallets · 8.648 lançamentos · 4.324 journals |

## 5. Análise honesta de gargalos

1. **Rate limit por instância é o teto efetivo**: 300 req/min por IP por instância
   (limiter em memória, não cota global — limitação documentada). Acima disso o
   provider recebe 429, não 5xx. Uma cota global exigiria Redis.
2. **Hot wallet é serial por invariante**, não por bug: o p95 do cenário ficou na
   faixa de 40 ms com 3 VUs disputando a mesma linha. A fila cresce linearmente com a
   concorrência — é o preço da consistência de saldo.
3. **Outbox não acumulou**: lag e backlog ficaram em 0 durante toda a carga; os 3
   publishers deram conta sem lease órfão.
4. **Latência p99 de 83 ms** no histograma do app (que mede o handler, não a fila do
   k6) mostra que o caminho crítico é dominado pelo lock + triggers deferred, não por
   I/O de rede.
5. **Não medido nesta rodada**: comparação 1 vs 3 instâncias (o cluster foi mantido em
   3 para também exercitar publishers/consumers concorrentes) e o cenário `mix_http_sqs`
   (já coberto funcionalmente por CC-04 e pela coleção Postman). LocalStack ≠ AWS: não
   extrapolar para produção.
6. **Máximo de 5,34 s** em uma requisição isolada durante o `hot_wallet`: efeito de
   fila do `lock_timeout` (2 s) + retry. Nenhum 5xx foi observado nesse cenário
   (`http_req_failed{scenario:hot_wallet} = 0%`).

## 6. Reprodução

```bash
docker compose up -d --no-build --wait
docker compose --profile tools run --rm migrate
docker compose --profile load run --rm k6      # TARGETS aponta para api-1/2/3
bun run scripts/verify-invariants.ts           # invariantes pós-carga
```

## 7. Anexos

- `test/load/wager-load.js` — cenários versionados (fonte dos números acima).
- Log completo da execução: `k6.log` (gerado na raiz ao rodar o comando acima).
- Dashboard Grafana provisionado: `infra/grafana/provisioning/dashboards/wagering-overview.json`.
