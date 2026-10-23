/**
 * IT-TRIG-01: mede o custo dos constraint triggers DEFERRED no caminho quente.
 * Executa N transações de BET plausíveis com e sem os triggers (owner role),
 * medindo p50/p95 e gravando o resultado em docs/trigger-benchmark.md.
 *
 * Uso: bun run scripts/benchmark-triggers.ts [iteracoes]
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../src/contexts/wagering/infrastructure/persistence/mikro-orm.config';
import { executeSql } from '../src/contexts/wagering/infrastructure/persistence/sql-session';
import { uuidv7 } from '../src/shared/ids/uuid7';

const ITERATIONS = Number(process.argv[2] ?? 300);
const MIGRATOR_URL =
  process.env.DATABASE_URL_MIGRATOR ??
  'postgres://wagering_migrator:wagering_migrator@localhost:5432/wagering';

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
};

const orm = await MikroORM.init(buildOrmConfig(MIGRATOR_URL, 4));

async function createWallet(amount: string): Promise<string> {
  const walletId = uuidv7();
  const playerId = uuidv7();
  // a criação precisa ser atômica: Σ=0 é verificada no COMMIT (trigger DEFERRED)
  await orm.em.transactional(async (trx) => {
    await executeSql(
      trx,
      `INSERT INTO wallets (id, player_id, currency, balance, version) VALUES ($1, $2, 'BRL', $3, 2)`,
      [walletId, playerId, amount],
    );
    const transactionId = uuidv7();
    const journalId = uuidv7();
    await executeSql(
      trx,
      `INSERT INTO wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, currency, round_id, game_id, kind, amount, status,
         resulting_balance_amount, processed_at)
       VALUES ($1,'system',$2,$3,'gt',$4,$5,'BRL','system','system','OPENING',$6,'PROCESSED',$6, now())`,
      [transactionId, `opening:${walletId}`, `k:${walletId}`, walletId, playerId, amount],
    );
    await executeSql(
      trx,
      `INSERT INTO journals (id, transaction_id, currency) VALUES ($1,$2,'BRL')`,
      [journalId, transactionId],
    );
    await executeSql(
      trx,
      `INSERT INTO ledger_entries (id, journal_id, transaction_id, wallet_id, account_id,
         direction, amount, currency, balance_before, balance_after, wallet_version)
       VALUES ($1,$2,$3,$4,NULL,'CREDIT',$5,'BRL',0,$5,2)`,
      [uuidv7(), journalId, transactionId, walletId, amount],
    );
    const [account] = await executeSql<{ id: string }>(
      trx,
      `SELECT id FROM accounts WHERE code = 'OPENING_EQUITY' AND owner = 'system' AND currency = 'BRL'`,
    );
    await executeSql(
      trx,
      `INSERT INTO ledger_entries (id, journal_id, transaction_id, wallet_id, account_id,
         direction, amount, currency, balance_before, balance_after, wallet_version)
       VALUES ($1,$2,$3,NULL,$4,'DEBIT',$5,'BRL',NULL,NULL,NULL)`,
      [uuidv7(), journalId, transactionId, account.id, amount],
    );
  });
  return walletId;
}

async function runBetBatch(label: string, disableTriggers: boolean): Promise<number[]> {
  if (disableTriggers) {
    await executeSql(orm.em, `ALTER TABLE wallets DISABLE TRIGGER trg_wallet_balance_consistency`);
    await executeSql(orm.em, `ALTER TABLE ledger_entries DISABLE TRIGGER trg_journal_balanced`);
  }

  const durations: number[] = [];
  try {
    for (let index = 0; index < ITERATIONS; index += 1) {
      const walletId = await createWallet('1000.00');
      const started = performance.now();
      await orm.em.transactional(async (trx) => {
        const transactionId = uuidv7();
        const journalId = uuidv7();
        await executeSql(
          trx,
          `UPDATE wallets SET balance = balance - 25.00, version = version + 1, updated_at = now() WHERE id = $1`,
          [walletId],
        );
        await executeSql(
          trx,
          `INSERT INTO wager_transactions (
             id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, currency, round_id, game_id, kind, amount, status,
             resulting_balance_amount, processed_at)
           VALUES ($1,'provider-a',$2,$3,'h',$4,(SELECT player_id FROM wallets WHERE id = $4),
                   'BRL','r','g','BET',25.00,'PROCESSED',975.00, now())`,
          [transactionId, `ext-${transactionId}`, `key-${transactionId}`, walletId],
        );
        await executeSql(
          trx,
          `INSERT INTO journals (id, transaction_id, currency) VALUES ($1,$2,'BRL')`,
          [journalId, transactionId],
        );
        await executeSql(
          trx,
          `INSERT INTO ledger_entries (id, journal_id, transaction_id, wallet_id, account_id,
             direction, amount, currency, balance_before, balance_after, wallet_version)
           VALUES ($1,$2,$3,$4,NULL,'DEBIT',25.00,'BRL',1000.00,975.00,3)`,
          [uuidv7(), journalId, transactionId, walletId],
        );
        const [account] = await executeSql<{ id: string }>(
          trx,
          `SELECT id FROM accounts WHERE code = 'PROVIDER_CLEARING' AND owner = 'provider-a' AND currency = 'BRL'`,
        );
        await executeSql(
          trx,
          `INSERT INTO ledger_entries (id, journal_id, transaction_id, wallet_id, account_id,
             direction, amount, currency, balance_before, balance_after, wallet_version)
           VALUES ($1,$2,$3,NULL,$4,'CREDIT',25.00,'BRL',NULL,NULL,NULL)`,
          [uuidv7(), journalId, transactionId, account.id],
        );
      });
      durations.push(performance.now() - started);
    }
  } finally {
    if (disableTriggers) {
      await executeSql(orm.em, `ALTER TABLE wallets ENABLE TRIGGER trg_wallet_balance_consistency`);
      await executeSql(orm.em, `ALTER TABLE ledger_entries ENABLE TRIGGER trg_journal_balanced`);
    }
  }
  console.log(
    `${label}: n=${durations.length} p50=${percentile(durations, 50).toFixed(2)}ms ` +
      `p95=${percentile(durations, 95).toFixed(2)}ms p99=${percentile(durations, 99).toFixed(2)}ms`,
  );
  return durations;
}

try {
  await executeSql(
    orm.em,
    `INSERT INTO accounts (id, code, owner, currency) VALUES ($1,'PROVIDER_CLEARING','provider-a','BRL')
     ON CONFLICT (code, owner, currency) DO NOTHING`,
    [uuidv7()],
  );
  const withTriggers = await runBetBatch('com triggers DEFERRED', false);
  const withoutTriggers = await runBetBatch('sem triggers (benchmark)', true);
  const deltaP95 =
    ((percentile(withTriggers, 95) - percentile(withoutTriggers, 95)) /
      Math.max(percentile(withoutTriggers, 95), 0.001)) *
    100;
  console.log(`overhead p95: ${deltaP95.toFixed(1)}%`);
} finally {
  await orm.close(true);
}
