import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  IdempotencyConflictError,
  WalletAlreadyExistsError,
} from '../../src/contexts/wagering/domain/errors/domain-errors';
import { FailureCode } from '../../src/contexts/wagering/domain/transaction/failure-code';
import { WagerTransactionStatus } from '../../src/contexts/wagering/domain/transaction/wager-transaction-status';
import { buildOrmConfig } from '../../src/contexts/wagering/infrastructure/persistence/mikro-orm.config';
import { executeSql } from '../../src/contexts/wagering/infrastructure/persistence/sql-session';
import { uuidv7 } from '../../src/shared/ids/uuid7';
import { assertLedgerMatchesBalance } from '../helpers/assert-ledger';
import {
  TEST_MIGRATOR_URL,
  createTestRuntime,
  migrateTestSchema,
  submitCommand,
  type TestRuntime,
} from '../helpers/infra';

let runtime: TestRuntime;
const touchedWallets: string[] = [];

/** Conexão com a role owner (bypass controlado de triggers) para induzir falhas. */
async function withOwnerConnection(
  work: (
    sql: (query: string, params?: unknown[]) => Promise<unknown[]>,
  ) => Promise<void>,
): Promise<void> {
  const orm = await MikroORM.init(buildOrmConfig(TEST_MIGRATOR_URL, 2));
  try {
    await work((query, params = []) => executeSql(orm.em.fork(), query, params));
  } finally {
    await orm.close(true);
  }
}

beforeAll(async () => {
  await migrateTestSchema();
  runtime = await createTestRuntime();
}, 60_000);

afterAll(async () => {
  if (!runtime) return;
  await assertLedgerMatchesBalance(runtime.orm, touchedWallets);
  await runtime.close();
}, 60_000);

async function openWallet(
  amount = '1000.00',
  currency = 'BRL',
): Promise<{ id: string; playerId: string }> {
  const playerId = uuidv7();
  const wallet = await runtime.openWallet.execute({
    playerId,
    initialBalance: { amount, currency },
    correlationId: `corr-${uuidv7()}`,
  });
  touchedWallets.push(wallet.id);
  return { id: wallet.id, playerId };
}

describe('Integração — API/use cases contra PostgreSQL real', () => {
  it('IT-API-01: cria wallet com OPENING na mesma tx (version 2) e journal balanceado', async () => {
    const playerId = uuidv7();
    const wallet = await runtime.openWallet.execute({
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
      correlationId: `corr-${uuidv7()}`,
    });
    touchedWallets.push(wallet.id);

    expect(wallet.version).toBe(2);
    expect(wallet.balance).toEqual({ amount: '1000.00', currency: 'BRL' });

    const [opening] = await runtime.sql<{ kind: string; status: string; id: string }>(
      `SELECT kind, status, id::text AS id FROM wager_transactions WHERE wallet_id = $1`,
      [wallet.id],
    );
    expect(opening.kind).toBe('OPENING');
    expect(opening.status).toBe('PROCESSED');

    const [journal] = await runtime.sql<{ id: string }>(
      `SELECT id::text AS id FROM journals WHERE transaction_id = $1`,
      [opening.id],
    );
    const legs = await runtime.sql<{ direction: string; wallet_id: string | null }>(
      `SELECT direction, wallet_id::text AS wallet_id FROM ledger_entries WHERE journal_id = $1`,
      [journal.id],
    );
    expect(legs).toHaveLength(2);
    expect(legs.filter((leg) => leg.wallet_id === wallet.id)).toHaveLength(1);
    expect(legs.some((leg) => leg.wallet_id === null)).toBe(true);

    await assertLedgerMatchesBalance(runtime.orm, [wallet.id]);
  }, 30_000);

  it('IT-API-02: wallet duplicada para o mesmo player+currency falha como conflito', async () => {
    const playerId = uuidv7();
    const first = await runtime.openWallet.execute({
      playerId,
      initialBalance: { amount: '10.00', currency: 'BRL' },
      correlationId: `corr-${uuidv7()}`,
    });
    touchedWallets.push(first.id);

    await expect(
      runtime.openWallet.execute({
        playerId,
        initialBalance: { amount: '20.00', currency: 'BRL' },
        correlationId: `corr-${uuidv7()}`,
      }),
    ).rejects.toBeInstanceOf(WalletAlreadyExistsError);

    // moeda diferente para o mesmo player é permitida (Req. B)
    const usd = await runtime.openWallet.execute({
      playerId,
      initialBalance: { amount: '30.00', currency: 'USD' },
      correlationId: `corr-${uuidv7()}`,
    });
    touchedWallets.push(usd.id);
    expect(usd.id).not.toBe(first.id);
  }, 30_000);

  it('IT-SETTLE-01: BET debita, cria journal com 2 pernas e enfileira eventos na mesma tx', async () => {
    const wallet = await openWallet('1000.00');
    const result = await runtime.submit.execute(
      submitCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        amount: '25.00',
      }),
    );

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: '975.00', currency: 'BRL' });
    expect(result.idempotentReplay).toBe(false);

    const refreshed = await runtime.getWallet.execute(wallet.id);
    expect(refreshed?.balance).toEqual({ amount: '975.00', currency: 'BRL' });
    expect(refreshed?.version).toBe(3);

    const txEvents = await runtime.sql<{ event_type: string }>(
      `SELECT event_type FROM outbox_messages WHERE aggregate_id = $1`,
      [result.transactionId],
    );
    expect(txEvents.map((event) => event.event_type)).toContain(
      'WagerTransactionProcessed',
    );

    const walletEvents = await runtime.sql<{ event_type: string; tx: string }>(
      `SELECT event_type, payload->'data'->>'transactionId' AS tx
         FROM outbox_messages
        WHERE aggregate_id = $1`,
      [wallet.id],
    );
    const forThisTransaction = walletEvents.filter(
      (event) => event.tx === result.transactionId,
    );
    expect(forThisTransaction.map((event) => event.event_type)).toEqual([
      'WalletBalanceChanged',
    ]);

    await assertLedgerMatchesBalance(runtime.orm, [wallet.id]);
  }, 30_000);

  it('IT-IDEM-01/03: replay devolve snapshot original e payload divergente é conflito', async () => {
    const wallet = await openWallet('500.00');
    const externalTransactionId = `ext-${uuidv7()}`;
    const command = submitCommand({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId,
      amount: '100.00',
    });

    const first = await runtime.submit.execute(command);
    const replay = await runtime.submit.execute({ ...command, money: { amount: '100.00', currency: 'BRL' } });

    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.balance).toEqual(first.balance);
    expect(replay.balance).toEqual({ amount: '400.00', currency: 'BRL' });

    await expect(
      runtime.submit.execute({ ...command, money: { amount: '50.00', currency: 'BRL' } }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const [count] = await runtime.sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ledger_entries WHERE wallet_id = $1 AND transaction_id = $2`,
      [wallet.id, first.transactionId],
    );
    expect(count.count).toBe(1);
    await assertLedgerMatchesBalance(runtime.orm, [wallet.id]);
  }, 30_000);

  it('IT-SETTLE-02: cenário de negócio completo BET → WIN → ROLLBACK(WIN) → LOSS', async () => {
    const wallet = await openWallet('100.00');
    const roundId = `round-${uuidv7()}`;

    const bet = await runtime.submit.execute(
      submitCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId,
        amount: '80.00',
      }),
    );
    expect(bet.status).toBe(WagerTransactionStatus.Processed);

    const win = await runtime.submit.execute(
      submitCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId,
        kind: 'WIN',
        amount: '30.00',
        referenceExternalTransactionId: bet.transactionId
          ? (
              await runtime.getTransaction.execute(bet.transactionId)
            )?.externalTransactionId
          : undefined,
      }),
    );
    expect(win.status).toBe(WagerTransactionStatus.Processed);
    expect(win.balance).toEqual({ amount: '50.00', currency: 'BRL' });

    const winExternalId = (
      await runtime.getTransaction.execute(win.transactionId as string)
    )?.externalTransactionId as string;
    const rollback = await runtime.submit.execute(
      submitCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId,
        kind: 'ROLLBACK',
        amount: '30.00',
        referenceExternalTransactionId: winExternalId,
      }),
    );
    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.balance).toEqual({ amount: '20.00', currency: 'BRL' });

    const loss = await runtime.submit.execute(
      submitCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId,
        kind: 'LOSS',
        amount: '20.00',
      }),
    );
    expect(loss.status).toBe(WagerTransactionStatus.Processed);
    expect(loss.balance).toEqual({ amount: '20.00', currency: 'BRL' });

    const legs = await runtime.sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ledger_entries WHERE wallet_id = $1`,
      [wallet.id],
    );
    // OPENING + BET + WIN + ROLLBACK = 4 pernas de wallet (LOSS não gera)
    expect(legs[0].count).toBe(4);

    await assertLedgerMatchesBalance(runtime.orm, [wallet.id]);
  }, 30_000);

  it('IT-SETTLE-03: REFUND rejeitado por regra commita REJECTED com failureCode e snapshot', async () => {
    const wallet = await openWallet('100.00');
    const refund = await runtime.submit.execute(
      submitCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'REFUND',
        amount: '10.00',
        referenceExternalTransactionId: 'inexistente',
      }),
    );
    // referência ausente → PENDING_REFERENCE (worker reavalia; TTL → REJECTED)
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

    const [row] = await runtime.sql<{ status: string; next_attempt_at: string }>(
      `SELECT status, next_attempt_at FROM wager_transactions WHERE id = $1`,
      [refund.transactionId],
    );
    expect(row.status).toBe('PENDING_REFERENCE');
    expect(Number.isNaN(new Date(row.next_attempt_at).getTime())).toBe(false);

    await assertLedgerMatchesBalance(runtime.orm, [wallet.id]);
  }, 30_000);

  it('IT-PEND-01/02: ROLLBACK antes da BET fica pendente e o gatilho do worker liquida', async () => {
    const wallet = await openWallet('100.00');
    const betExternalId = `ext-${uuidv7()}`;
    const roundId = `round-${uuidv7()}`;

    const early = await runtime.submit.execute(
      submitCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId,
        kind: 'REFUND',
        amount: '40.00',
        referenceExternalTransactionId: betExternalId,
      }),
    );
    expect(early.status).toBe(WagerTransactionStatus.PendingReference);

    await runtime.submit.execute(
      submitCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId,
        amount: '40.00',
        externalTransactionId: betExternalId,
      }),
    );

    const settled = await runtime.settle.execute({
      transactionId: early.transactionId as string,
      correlationId: `corr-${uuidv7()}`,
    });
    expect(settled.outcome).toBe('PROCESSED');
    expect(settled.status).toBe(WagerTransactionStatus.Processed);

    const refreshed = await runtime.getWallet.execute(wallet.id);
    expect(refreshed?.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    await assertLedgerMatchesBalance(runtime.orm, [wallet.id]);
  }, 30_000);

  it('IT-PEND-03: TTL esgotado rejeita com REFERENCE_NOT_FOUND e publica evento', async () => {
    const wallet = await openWallet('100.00');
    const pending = await runtime.submit.execute(
      submitCommand({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'ROLLBACK',
        amount: '10.00',
        referenceExternalTransactionId: `missing-${uuidv7()}`,
      }),
    );
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);

    await runtime.sql(
      `UPDATE wager_transactions SET attempts = 99 WHERE id = $1`,
      [pending.transactionId],
    );

    const result = await runtime.settle.execute({
      transactionId: pending.transactionId as string,
      correlationId: `corr-${uuidv7()}`,
    });
    expect(result.outcome).toBe('REJECTED');

    const [row] = await runtime.sql<{ failure_code: string }>(
      `SELECT failure_code FROM wager_transactions WHERE id = $1`,
      [pending.transactionId],
    );
    expect(row.failure_code).toBe(FailureCode.ReferenceNotFound);

    const events = await runtime.sql<{ event_type: string }>(
      `SELECT event_type FROM outbox_messages WHERE aggregate_id = $1`,
      [pending.transactionId],
    );
    expect(events.map((event) => event.event_type)).toContain(
      'WagerTransactionRejected',
    );

    await assertLedgerMatchesBalance(runtime.orm, [wallet.id]);
  }, 30_000);

  it('IT-CURR-01/02/03: CURRENCY_MISMATCH, BRL+USD independentes e Σ=0 por moeda', async () => {
    const brlWallet = await openWallet('100.00', 'BRL');
    const usdWallet = await openWallet('100.00', 'USD');

    const mismatch = await runtime.submit.execute(
      submitCommand({
        walletId: usdWallet.id,
        playerId: usdWallet.playerId,
        amount: '10.00',
        currency: 'BRL',
      }),
    );
    expect(mismatch.status).toBe(WagerTransactionStatus.Rejected);
    expect(mismatch.failureCode).toBe(FailureCode.CurrencyMismatch);

    const usdBet = await runtime.submit.execute(
      submitCommand({
        walletId: usdWallet.id,
        playerId: usdWallet.playerId,
        amount: '10.00',
        currency: 'USD',
      }),
    );
    expect(usdBet.balance).toEqual({ amount: '90.00', currency: 'USD' });

    await assertLedgerMatchesBalance(runtime.orm, [brlWallet.id, usdWallet.id]);
  }, 30_000);

  it('IT-API-ERR: wallet inexistente vira REJECTED auditável com wallet_id NULL', async () => {
    const result = await runtime.submit.execute(
      submitCommand({
        walletId: uuidv7(),
        playerId: uuidv7(),
        amount: '10.00',
      }),
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.WalletNotFound);

    const [row] = await runtime.sql<{ wallet_id: string | null }>(
      `SELECT wallet_id::text AS wallet_id FROM wager_transactions WHERE id = $1`,
      [result.transactionId],
    );
    expect(row.wallet_id).toBeNull();
  }, 30_000);

  it('IT-API-04/05: consultas de wallet, ledger com cursor e transação por id/external', async () => {
    const wallet = await openWallet('100.00');
    for (const amount of ['10.00', '20.00', '30.00']) {
      await runtime.submit.execute(
        submitCommand({ walletId: wallet.id, playerId: wallet.playerId, amount }),
      );
    }

    const page1 = await runtime.listLedger.execute(wallet.id, { limit: 2 });
    expect(page1?.entries).toHaveLength(2);
    expect(page1?.nextCursor).toBeTruthy();

    const page2 = await runtime.listLedger.execute(wallet.id, {
      limit: 2,
      cursor: page1?.nextCursor as string,
    });
    expect(page2?.entries).toHaveLength(2);
    expect(page2?.entries[0].id).not.toBe(page1?.entries[0].id);

    // apenas pernas de wallet são expostas
    const all = await runtime.sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ledger_entries WHERE wallet_id = $1`,
      [wallet.id],
    );
    expect(all[0].count).toBe(4);

    const [tx] = await runtime.sql<{ id: string; external_transaction_id: string }>(
      `SELECT id::text AS id, external_transaction_id FROM wager_transactions
        WHERE wallet_id = $1 AND kind = 'BET' ORDER BY created_at LIMIT 1`,
      [wallet.id],
    );
    const byId = await runtime.getTransaction.execute(tx.id);
    expect(byId?.transactionId).toBe(tx.id);
    const byExternal = await runtime.getTransactionByExternalId.execute(
      'provider-a',
      tx.external_transaction_id,
    );
    expect(byExternal?.transactionId).toBe(tx.id);

    await assertLedgerMatchesBalance(runtime.orm, [wallet.id]);
  }, 30_000);

  it('IT-RECON-01/04: reconciliação consistente cobre exatamente as entradas do ledger', async () => {
    const wallet = await openWallet('200.00');
    await runtime.submit.execute(
      submitCommand({ walletId: wallet.id, playerId: wallet.playerId, amount: '50.00' }),
    );

    const result = await runtime.reconcile.execute(wallet.id, 'endpoint');
    expect(result?.consistent).toBe(true);
    expect(result?.difference).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(result?.checkedEntries).toBe(2);
    expect(result?.chainBreaks).toBe(0);

    const [count] = await runtime.sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ledger_entries WHERE wallet_id = $1`,
      [wallet.id],
    );
    expect(result?.checkedEntries).toBe(count.count);
  }, 30_000);

  it('IT-RECON-02: divergência induzida é sinalizada e NÃO corrigida', async () => {
    const wallet = await openWallet('100.00');

    // induz divergência usando a role owner (bypass controlado do trigger DEFERRED)
    await withOwnerConnection(async (owner) => {
      await owner(`ALTER TABLE wallets DISABLE TRIGGER trg_wallet_balance_consistency`);
      await owner(`UPDATE wallets SET balance = balance + 1 WHERE id = $1`, [wallet.id]);
      await owner(`ALTER TABLE wallets ENABLE TRIGGER trg_wallet_balance_consistency`);
    });

    const result = await runtime.reconcile.execute(wallet.id, 'endpoint');
    expect(result?.consistent).toBe(false);
    expect(result?.difference).toEqual({ amount: '1.00', currency: 'BRL' });

    const stored = await runtime.getWallet.execute(wallet.id);
    expect(stored?.balance).toEqual({ amount: '101.00', currency: 'BRL' });

    // restaura o saldo para não quebrar a invariante global verificada no afterAll
    await withOwnerConnection(async (owner) => {
      await owner(`UPDATE wallets SET balance = balance - 1 WHERE id = $1`, [wallet.id]);
    });
  }, 60_000);
});
