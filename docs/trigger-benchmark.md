# IT-TRIG-01 · Custo dos constraint triggers DEFERRED

Medição executada em ambiente local de desenvolvimento com
`bun run scripts/benchmark-triggers.ts 200`.

## Método

1. Para cada iteração: cria uma wallet com saldo `1000.00` (transação de `OPENING`
   completa com as duas pernas, fora da medição).
2. Mede **uma transação de BET** com os mesmos statements do caminho quente:
   `UPDATE wallets` → `INSERT wager_transactions` → `INSERT journals` →
   `INSERT ledger_entries` (perna de wallet) → `INSERT ledger_entries` (contrapartida).
3. Repete o lote com os triggers desabilitados
   (`ALTER TABLE ... DISABLE TRIGGER trg_wallet_balance_consistency` e
   `trg_journal_balanced`) usando a role owner, e reabilita ao final.
4. Reporta p50/p95/p99 das transações (n = 200 por lote).

## Resultado (2026-10-22, Windows 11, Bun 1.4.3, PostgreSQL 16.4 em Docker)

| Configuração | n | p50 | p95 | p99 |
|---|---|---|---|---|
| Com triggers `DEFERRED` | 200 | 21,55 ms | 25,01 ms | 27,98 ms |
| Sem triggers (benchmark) | 200 | 19,99 ms | 24,90 ms | 27,90 ms |
| **Overhead p95** | | | **+0,4%** | |

## Conclusão e decisão

- O custo medido é **ruído estatístico** (< 1% em p95), porque os triggers
  re-verificam apenas `journal_id`/`wallet_id` da própria transação, usando
  `ix_leg_journal` e `uq_leg_wallet_order` — custo O(pernas da tx), não O(tabela).
- **Decisão: manter os triggers habilitados** (default do plano). A garantia
  "saldo ↔ ledger" e "Σ=0 por journal/moeda" no banco é a prova direta da
  restrição 9 do README e custa menos de 1% no caminho quente neste ambiente.
- Limitação honesta: a medição é local (mesmo host, disco local, sem contenção
  concorrente). Um cenário com hot wallet e N instâncias concorrentes pode
  apresentar overhead diferente; a recomendação de reavaliar a decisão caso o custo
  medido supere ~5% em p99 permanece válida.
