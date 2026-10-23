import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { FailureCode } from '../../src/contexts/wagering/domain/transaction/failure-code';
import { WagerTransactionStatus } from '../../src/contexts/wagering/domain/transaction/wager-transaction-status';
import { uuidv7 } from '../../src/shared/ids/uuid7';
import { assertLedgerMatchesBalance } from '../helpers/assert-ledger';
import { runInParallel } from '../helpers/barrier';
import {
  createTestRuntime,
  migrateTestSchema,
  submitCommand,
  type TestRuntime,
} from '../helpers/infra';

let runtime: TestRuntime;
const touchedWallets: string[] = [];

beforeAll(async () => {
  await migrateTestSchema();
  runtime = await createTestRuntime();
}, 60_000);

afterAll(async () => {
  if (!runtime) return;
  await assertLedgerMatchesBalance(runtime.orm, touchedWallets);
  await runtime.close();
}, 60_000);

async function openWallet(amount: string, currency = 'BRL') {
  const playerId = uuidv7();
  const wallet = await runtime.openWallet.execute({
    playerId,
    initialBalance: { amount, currency },
    correlationId: `corr-${uuidv7()}`,
  });
  touchedWallets.push(wallet.id);
  return { id: wallet.id, playerId };
}

describe('Concorrência real (paralelismo de Promises contra PostgreSQL)', () => {
  it('CC-01: 50 envios paralelos da mesma aposta → 1 PROCESSED, 49 replays e 1 débito', async () => {
    const wallet = await openWallet('1000.00');
    const externalTransactionId = `ext-${uuidv7()}`;
    const command = submitCommand({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId,
      amount: '100.00',
    });

    const settled = await runInParallel(50, () => runtime.submit.execute(command));
    const failures = settled.filter((item) => item.status === 'rejected');
    expect(failures).toHaveLength(0);

    const results = settled.map(
      (item) => (item as PromiseFulfilledResult<Awaited<ReturnType<typeof runtime.submit.execute>>>).value,
    );
    const processed = results.filter((result) => !result.idempotentReplay);
    const replays = results.filter((result) => result.idempotentReplay);

    expect(processed).toHaveLength(1);
    expect(replays).toHaveLength(49);
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(processed[0].balance).toEqual({ amount: '900.00', currency: 'BRL' });

    const [debits] = await runtime.sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ledger_entries
        WHERE wallet_id = $1 AND direction = 'DEBIT'`,
      [wallet.id],
    );
    expect(debits.count).toBe(1);

    await assertLedgerMatchesBalance(runtime.orm, [wallet.id]);
  }, 120_000);

  it('CC-02: cenário 2×80 simultâneo → 1 PROCESSED, 1 REJECTED INSUFFICIENT_FUNDS, saldo 20.00', async () => {
    const wallet = await openWallet('100.00');

    const settled = await runInParallel(2, (index) =>
      runtime.submit.execute(
        submitCommand({
          walletId: wallet.id,
          playerId: wallet.playerId,
          amount: '80.00',
          externalTransactionId: `ext-race-${index}-${uuidv7()}`,
        }),
      ),
    );

    const results = settled.map(
      (item) => (item as PromiseFulfilledResult<Awaited<ReturnType<typeof runtime.submit.execute>>>).value,
    );
    const processed = results.filter(
      (result) => result.status === WagerTransactionStatus.Processed,
    );
    const rejected = results.filter(
      (result) => result.status === WagerTransactionStatus.Rejected,
    );

    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].failureCode).toBe(FailureCode.InsufficientFunds);

    const stored = await runtime.getWallet.execute(wallet.id);
    expect(stored?.balance).toEqual({ amount: '20.00', currency: 'BRL' });

    const [debits] = await runtime.sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ledger_entries
        WHERE wallet_id = $1 AND direction = 'DEBIT'`,
      [wallet.id],
    );
    expect(debits.count).toBe(1);

    await assertLedgerMatchesBalance(runtime.orm, [wallet.id]);
  }, 120_000);

  it('CC-03: 100 wallets distintas em paralelo processam sem lock global', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 100 }, () => openWallet('50.00')),
    );

    const startedAt = Date.now();
    const settled = await runInParallel(100, (index) =>
      runtime.submit.execute(
        submitCommand({
          walletId: wallets[index].id,
          playerId: wallets[index].playerId,
          amount: '10.00',
        }),
      ),
    );
    const elapsed = Date.now() - startedAt;

    const results = settled.map(
      (item) => (item as PromiseFulfilledResult<Awaited<ReturnType<typeof runtime.submit.execute>>>).value,
    );
    expect(results.every((result) => result.status === WagerTransactionStatus.Processed)).toBe(
      true,
    );
    // 100 tx independentes não podem ser serializadas por um lock global
    expect(elapsed).toBeLessThan(30_000);

    await assertLedgerMatchesBalance(
      runtime.orm,
      wallets.map((wallet) => wallet.id),
    );
  }, 180_000);

  it('CC-05: 2 ROLLBACKs da mesma WIN em paralelo → 1 PROCESSED e 1 REVERSAL_ALREADY_APPLIED', async () => {
    const wallet = await openWallet('100.00');
    const roundId = `round-${uuidv7()}`;
    const win = await runtime.submit.execute(
      submitCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId,
        kind: 'WIN',
        amount: '30.00',
      }),
    );
    expect(win.status).toBe(WagerTransactionStatus.Processed);
    const winExternalId = (
      await runtime.getTransaction.execute(win.transactionId as string)
    )?.externalTransactionId as string;

    const settled = await runInParallel(2, () =>
      runtime.submit.execute(
        submitCommand({
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId,
          kind: 'ROLLBACK',
          amount: '30.00',
          referenceExternalTransactionId: winExternalId,
        }),
      ),
    );
    const results = settled.map(
      (item) => (item as PromiseFulfilledResult<Awaited<ReturnType<typeof runtime.submit.execute>>>).value,
    );
    const processed = results.filter(
      (result) => result.status === WagerTransactionStatus.Processed,
    );
    const rejected = results.filter(
      (result) => result.status === WagerTransactionStatus.Rejected,
    );
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].failureCode).toBe(FailureCode.ReversalAlreadyApplied);

    const stored = await runtime.getWallet.execute(wallet.id);
    expect(stored?.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    await assertLedgerMatchesBalance(runtime.orm, [wallet.id]);
  }, 120_000);
});
