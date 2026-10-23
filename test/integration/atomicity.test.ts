import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type {
  TransactionRunner,
  UnitOfWork,
} from '../../src/contexts/wagering/application/ports/unit-of-work';
import { SubmitWagerTransaction } from '../../src/contexts/wagering/application/use-cases/submit-wager-transaction';
import { Money } from '../../src/contexts/wagering/domain/money/money';
import { buildOrmConfig } from '../../src/contexts/wagering/infrastructure/persistence/mikro-orm.config';
import { executeSql } from '../../src/contexts/wagering/infrastructure/persistence/sql-session';
import { NoopTracer } from '../../src/contexts/wagering/infrastructure/observability/tracing/tracing';
import { systemClock } from '../../src/shared/clock/system-clock';
import { uuidv7 } from '../../src/shared/ids/uuid7';
import { runInParallel } from '../helpers/barrier';
import { assertLedgerMatchesBalance } from '../helpers/assert-ledger';
import { TEST_MIGRATOR_URL, createTestRuntime, submitCommand, type TestRuntime } from '../helpers/infra';

let rt: TestRuntime;
let migratorOrm: MikroORM;
const touched: string[] = [];

/** Runner que aborta a transação **depois** de todo o trabalho do use case. */
class CrashAfterWorkRunner implements TransactionRunner {
  private calls = 0;

  constructor(private readonly inner: TransactionRunner) {}

  async run<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    return this.inner.run(async (uow) => {
      const result = await work(uow);
      this.calls += 1;
      if (this.calls === 1) {
        throw new Error('fault-inject: morte após o ledger, antes do COMMIT');
      }
      return result;
    });
  }
}

async function openWallet(amount = '1000.00', currency = 'BRL') {
  const playerId = uuidv7();
  const wallet = await rt.openWallet.execute({
    playerId,
    initialBalance: { amount, currency },
    correlationId: `corr-${uuidv7()}`,
  });
  touched.push(wallet.id);
  return { walletId: wallet.id, playerId };
}

beforeAll(async () => {
  rt = await createTestRuntime();
  migratorOrm = await MikroORM.init(buildOrmConfig(TEST_MIGRATOR_URL, 2));
}, 120_000);

afterAll(async () => {
  await assertLedgerMatchesBalance(rt.orm, touched);
  await migratorOrm.close(true);
  await rt.close();
}, 120_000);

describe('Atomicidade e idempotência (IT-TX / IT-IDEM / IT-CURR / IT-SCHEMA)', () => {
  it('IT-TX-01: morte após o ledger faz rollback total (sem wallet/journal/pernas/outbox/inbox)', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    const crashing = new SubmitWagerTransaction(
      new CrashAfterWorkRunner(rt.runner),
      systemClock,
      rt.ids,
      { isAllowed: (providerId) => rt.config.providers.has(providerId) },
      rt.config.currencies,
      new NoopTracer(),
      rt.metrics,
      rt.logger,
    );
    const externalTransactionId = `fault-${uuidv7()}`;

    await expect(
      crashing.execute(
        submitCommand({ playerId, walletId, externalTransactionId, amount: '10.00' }),
      ),
    ).rejects.toThrow(/fault-inject/);

    const [wallet] = await rt.sql<{ balance: string; version: string }>(
      `SELECT balance::text, version::text FROM wallets WHERE id = $1`,
      [walletId],
    );
    expect(wallet.balance).toBe('100.00');
    expect(wallet.version).toBe('2');

    const [counts] = await rt.sql<{
      tx: number;
      journals: number;
      legs: number;
      outbox: number;
      inbox: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM wager_transactions WHERE external_transaction_id = $1) AS tx,
         (SELECT COUNT(*)::int FROM journals j JOIN wager_transactions t ON t.id = j.transaction_id
           WHERE t.external_transaction_id = $1) AS journals,
         (SELECT COUNT(*)::int FROM ledger_entries e JOIN wager_transactions t ON t.id = e.transaction_id
           WHERE t.external_transaction_id = $1) AS legs,
         (SELECT COUNT(*)::int FROM outbox_messages
           WHERE payload::text LIKE '%' || $1 || '%') AS outbox,
         (SELECT COUNT(*)::int FROM inbox_messages WHERE message_id LIKE $1 || '%') AS inbox`,
      [externalTransactionId],
    );
    expect(counts).toEqual({ tx: 0, journals: 0, legs: 0, outbox: 0, inbox: 0 });
    await assertLedgerMatchesBalance(rt.orm, [walletId]);
  }, 60_000);

  it('IT-TX-02: forks paralelos não compartilham Identity Map (rollback não vaza estado)', async () => {
    const { walletId } = await openWallet('100.00');
    const before = await rt.getWallet.execute(walletId);
    expect(before?.balance.amount).toBe('100.00');

    await expect(
      rt.runner.run(async (uow) => {
        const wallet = await uow.wallets.findByIdForUpdate(walletId);
        wallet?.debit(Money.of('30.00', wallet.currency));
        if (wallet) await uow.wallets.applyBalance(wallet);
        throw new Error('rollback proposital');
      }),
    ).rejects.toThrow(/rollback proposital/);

    const after = await rt.getWallet.execute(walletId);
    expect(after?.balance.amount).toBe('100.00');
    expect(after?.version).toBe(before?.version);

    const ledger = await rt.listLedger.execute(walletId, { limit: 50 });
    expect(ledger?.entries.length).toBe(1);
    expect(String(ledger?.entries[0].direction)).toBe('CREDIT');
    await assertLedgerMatchesBalance(rt.orm, [walletId]);
  }, 60_000);

  it('IT-IDEM-02: 50 envios paralelos da mesma chave → 1 PROCESSED, 49 replays, 1 débito', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    const externalTransactionId = `dup-${uuidv7()}`;
    const command = submitCommand({
      playerId,
      walletId,
      externalTransactionId,
      amount: '10.00',
    });

    const settled = await runInParallel(50, () => rt.submit.execute({ ...command }));
    const results = settled.map((item) => {
      if (item.status === 'rejected') throw item.reason;
      return item.value;
    });

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);

    const [counts] = await rt.sql<{ debits: number; balance: string }>(
      `SELECT COUNT(*)::int AS debits FROM ledger_entries
         WHERE wallet_id = $1 AND direction = 'DEBIT'`,
      [walletId],
    );
    expect(counts.debits).toBe(1);

    const wallet = await rt.getWallet.execute(walletId);
    expect(wallet?.balance.amount).toBe('90.00');
    await assertLedgerMatchesBalance(rt.orm, [walletId]);
  }, 120_000);

  it('IT-IDEM-04: key diferente com o mesmo external id cai em replay (unique provider+external)', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    const externalTransactionId = `same-ext-${uuidv7()}`;
    const first = await rt.submit.execute(
      submitCommand({ playerId, walletId, externalTransactionId, amount: '7.00' }),
    );
    const second = await rt.submit.execute(
      submitCommand({
        playerId,
        walletId,
        externalTransactionId,
        amount: '7.00',
        idempotencyKey: `outra-key-${uuidv7()}`,
      }),
    );

    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    const wallet = await rt.getWallet.execute(walletId);
    expect(wallet?.balance.amount).toBe('93.00');
    await assertLedgerMatchesBalance(rt.orm, [walletId]);
  }, 60_000);

  it('IT-IDEM-05: replay de REJECTED devolve o mesmo failureCode', async () => {
    const { walletId, playerId } = await openWallet('10.00');
    const command = submitCommand({
      playerId,
      walletId,
      externalTransactionId: `rej-${uuidv7()}`,
      amount: '50.00',
    });
    const first = await rt.submit.execute({ ...command });
    expect(String(first.status)).toBe('REJECTED');
    expect(String(first.failureCode)).toBe('INSUFFICIENT_FUNDS');

    const replay = await rt.submit.execute({ ...command });
    expect(String(replay.status)).toBe('REJECTED');
    expect(String(replay.failureCode)).toBe('INSUFFICIENT_FUNDS');
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    await assertLedgerMatchesBalance(rt.orm, [walletId]);
  }, 60_000);

  it('IT-IDEM-06: replay de PENDING_REFERENCE mantém o aceite pendente', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    const command = submitCommand({
      playerId,
      walletId,
      kind: 'REFUND',
      amount: '10.00',
      referenceExternalTransactionId: `ghost-${uuidv7()}`,
      externalTransactionId: `pend-${uuidv7()}`,
    });
    const first = await rt.submit.execute({ ...command });
    expect(String(first.status)).toBe('PENDING_REFERENCE');

    const replay = await rt.submit.execute({ ...command });
    expect(String(replay.status)).toBe('PENDING_REFERENCE');
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    await assertLedgerMatchesBalance(rt.orm, [walletId]);
  }, 60_000);

  it('IT-CURR-04: moeda fora da allow-list no canal interno vira REJECTED UNSUPPORTED_CURRENCY', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    const result = await rt.submit.execute(
      submitCommand({
        playerId,
        walletId,
        externalTransactionId: `cur-${uuidv7()}`,
        amount: '5.00',
        currency: 'JPY',
      }),
    );
    expect(String(result.status)).toBe('REJECTED');
    expect(String(result.failureCode)).toBe('UNSUPPORTED_CURRENCY');
    const wallet = await rt.getWallet.execute(walletId);
    expect(wallet?.balance.amount).toBe('100.00');
    await assertLedgerMatchesBalance(rt.orm, [walletId]);
  }, 60_000);

  it('IT-SCHEMA-03: NUMERIC(19,2) faz round-trip sem perda como string', async () => {
    const amount = '12345678901234567.89';
    const { walletId } = await openWallet(amount);
    const wallet = await rt.getWallet.execute(walletId);
    expect(wallet?.balance.amount).toBe(amount);
    expect(typeof wallet?.balance.amount).toBe('string');

    const ledger = await rt.listLedger.execute(walletId, { limit: 10 });
    expect(ledger?.entries[0].money.amount).toBe(amount);
    expect(ledger?.entries[0].balanceAfter.amount).toBe(amount);
    await assertLedgerMatchesBalance(rt.orm, [walletId]);
  }, 60_000);

  it('IT-RECON-03: chain check detecta quebra induzida na cadeia balance_before/after', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    await rt.submit.execute(
      submitCommand({ playerId, walletId, externalTransactionId: `c1-${uuidv7()}`, amount: '10.00' }),
    );
    await rt.submit.execute(
      submitCommand({ playerId, walletId, externalTransactionId: `c2-${uuidv7()}`, amount: '10.00' }),
    );

    const clean = await rt.reconcile.execute(walletId, 'endpoint');
    expect(clean?.chainBreaks).toBe(0);
    expect(clean?.consistent).toBe(true);

    // A role da aplicação NÃO consegue tocar o ledger (trigger P0001) — prova da
    // restrição 5. Para exercitar o detector de cadeia, o owner desabilita o trigger
    // de UPDATE por um instante e restaura no mesmo bloco.
    const em = migratorOrm.em.fork();
    await expect(
      executeSql(em, `UPDATE ledger_entries SET balance_before = balance_before + 1 WHERE wallet_id = $1`, [
        walletId,
      ]),
    ).rejects.toThrow(/ledger is immutable/);

    const bumpEntry = async (delta: number): Promise<void> => {
      await executeSql(em, `ALTER TABLE ledger_entries DISABLE TRIGGER trg_leg_no_update`);
      try {
        await executeSql(
          em,
          `UPDATE ledger_entries
              SET balance_before = balance_before + $2, balance_after = balance_after + $2
            WHERE id = (SELECT id FROM ledger_entries WHERE wallet_id = $1
                         ORDER BY wallet_version, id OFFSET 1 LIMIT 1)`,
          [walletId, delta],
        );
      } finally {
        await executeSql(em, `ALTER TABLE ledger_entries ENABLE TRIGGER trg_leg_no_update`);
      }
    };

    await bumpEntry(1);
    const broken = await rt.reconcile.execute(walletId, 'endpoint');
    expect(broken?.chainBreaks).toBeGreaterThan(0);
    expect(broken?.consistent).toBe(false);
    // saldo continua igual ao ledger (a quebra é estrutural, não de soma)
    expect(broken?.difference.amount).toBe('0.00');

    await bumpEntry(-1);
    const restored = await rt.reconcile.execute(walletId, 'endpoint');
    expect(restored?.chainBreaks).toBe(0);
    expect(restored?.consistent).toBe(true);
    await assertLedgerMatchesBalance(rt.orm, [walletId]);
  }, 60_000);
});
