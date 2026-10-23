import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { uuidv7 } from '../../src/shared/ids/uuid7';
import {
  createTestRuntime,
  migrateTestSchema,
  type TestRuntime,
} from '../helpers/infra';

let runtime: TestRuntime;

beforeAll(async () => {
  await migrateTestSchema();
  runtime = await createTestRuntime();
}, 60_000);

afterAll(async () => {
  if (!runtime) return;
  await runtime.close();
});

const sqlStateOf = (error: unknown): string | undefined =>
  (error as { code?: string }).code;

async function openWallet(amount: string, currency = 'BRL') {
  const playerId = uuidv7();
  const wallet = await runtime.openWallet.execute({
    playerId,
    initialBalance: { amount, currency },
    correlationId: `corr-${uuidv7()}`,
  });
  return { wallet, playerId };
}

describe('Schema — garantias no banco (IT-SCHEMA / IT-LEDGER)', () => {
  it('IT-SCHEMA-01: CHECK de saldo negativo e de amount ≤ 0 são recusados', async () => {
    const { wallet } = await openWallet('10.00');

    let balanceError: unknown;
    try {
      await runtime.sql(`UPDATE wallets SET balance = -1 WHERE id = $1`, [wallet.id]);
    } catch (error) {
      balanceError = error;
    }
    expect(sqlStateOf(balanceError)).toBe('23514');

    let amountError: unknown;
    try {
      await runtime.sql(
        `INSERT INTO wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, currency, round_id, game_id, kind, amount, status)
         VALUES ($1,'p','e',$2,'h',$3,$4,'BRL','r','g','BET',-5.00,'PENDING')`,
        [uuidv7(), `k-${uuidv7()}`, wallet.id, wallet.playerId],
      );
    } catch (error) {
      amountError = error;
    }
    expect(sqlStateOf(amountError)).toBe('23514');
  }, 60_000);

  it('IT-LEDGER-02/03: ledger e journals são imutáveis (UPDATE/DELETE/TRUNCATE)', async () => {
    const { wallet } = await openWallet('10.00');

    const attempts: Array<() => Promise<unknown>> = [
      () => runtime.sql(`UPDATE ledger_entries SET amount = 1 WHERE wallet_id = $1`, [wallet.id]),
      () => runtime.sql(`DELETE FROM ledger_entries WHERE wallet_id = $1`, [wallet.id]),
      () => runtime.sql(`TRUNCATE ledger_entries`),
      () => runtime.sql(`UPDATE journals SET currency = 'USD'`),
      () => runtime.sql(`DELETE FROM journals`),
      () => runtime.sql(`TRUNCATE journals`),
      () => runtime.sql(`DELETE FROM wager_transactions`),
      () => runtime.sql(`DELETE FROM accounts`),
    ];

    for (const attempt of attempts) {
      let error: unknown;
      try {
        await attempt();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      // 42501 = permissão negada (role da app) | P0001 = trigger de imutabilidade
      expect(['42501', 'P0001']).toContain(sqlStateOf(error) as string);
    }
  }, 60_000);

  it('IT-LEDGER-04: journal desbalanceado falha no COMMIT (constraint trigger DEFERRED)', async () => {
    const { wallet } = await openWallet('10.00');
    const transactionId = uuidv7();
    const journalId = uuidv7();

    let error: unknown;
    try {
      await runtime.orm.em.fork().transactional(async (trx) => {
        const { executeSql } = await import(
          '../../src/contexts/wagering/infrastructure/persistence/sql-session'
        );
        await executeSql(
          trx,
          `INSERT INTO wager_transactions (
             id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, currency, round_id, game_id, kind, amount, status)
           VALUES ($1,'p',$2,$3,'h',$4,$5,'BRL','r','g','BET',10.00,'PROCESSED')`,
          [transactionId, `e-${uuidv7()}`, `k-${uuidv7()}`, wallet.id, wallet.playerId],
        );
        await executeSql(
          trx,
          `INSERT INTO journals (id, transaction_id, currency) VALUES ($1,$2,'BRL')`,
          [journalId, transactionId],
        );
        // apenas UMA perna → Σ débitos ≠ Σ créditos no commit
        await executeSql(
          trx,
          `INSERT INTO ledger_entries (
             id, journal_id, transaction_id, wallet_id, account_id, direction, amount,
             currency, balance_before, balance_after, wallet_version)
           VALUES ($1,$2,$3,$4,NULL,'CREDIT',10.00,'BRL',0,10,2)`,
          [uuidv7(), journalId, transactionId, wallet.id],
        );
      });
    } catch (caught) {
      error = caught;
    }
    expect(sqlStateOf(error)).toBe('23514');
  }, 60_000);

  it('IT-LEDGER-05: wallets.balance divergente do último balance_after falha no COMMIT', async () => {
    const { wallet } = await openWallet('10.00');

    let error: unknown;
    try {
      await runtime.orm.em.fork().transactional(async (trx) => {
        const { executeSql } = await import(
          '../../src/contexts/wagering/infrastructure/persistence/sql-session'
        );
        await executeSql(trx, `UPDATE wallets SET balance = balance + 5 WHERE id = $1`, [
          wallet.id,
        ]);
      });
    } catch (caught) {
      error = caught;
    }
    expect(sqlStateOf(error)).toBe('23514');
  }, 60_000);

  it('IT-SCHEMA-02: unicidade de idempotency_key, provider+external, wallet+tx e player+currency', async () => {
    const { wallet, playerId } = await openWallet('10.00');

    let duplicateWallet: unknown;
    try {
      await runtime.openWallet.execute({
        playerId,
        initialBalance: { amount: '1.00', currency: 'BRL' },
        correlationId: `corr-${uuidv7()}`,
      });
    } catch (error) {
      duplicateWallet = error;
    }
    expect((duplicateWallet as { name?: string }).name).toBe('WalletAlreadyExistsError');

    const [opening] = await runtime.sql<{ idempotency_key: string; external_transaction_id: string }>(
      `SELECT idempotency_key, external_transaction_id FROM wager_transactions WHERE wallet_id = $1`,
      [wallet.id],
    );

    let duplicateKey: unknown;
    try {
      await runtime.sql(
        `INSERT INTO wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, currency, round_id, game_id, kind, amount, status)
         VALUES ($1,'provider-a',$2,$3,'h',$4,$5,'BRL','r','g','BET',1.00,'PROCESSED')`,
        [
          uuidv7(),
          `other-${uuidv7()}`,
          opening.idempotency_key,
          wallet.id,
          wallet.playerId,
        ],
      );
    } catch (error) {
      duplicateKey = error;
    }
    expect(sqlStateOf(duplicateKey)).toBe('23505');

    let duplicateExternal: unknown;
    try {
      await runtime.sql(
        `INSERT INTO wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, currency, round_id, game_id, kind, amount, status)
         VALUES ($1,'system',$2,$3,'h',$4,$5,'BRL','r','g','BET',1.00,'PROCESSED')`,
        [
          uuidv7(),
          opening.external_transaction_id,
          `k-${uuidv7()}`,
          wallet.id,
          wallet.playerId,
        ],
      );
    } catch (error) {
      duplicateExternal = error;
    }
    expect(sqlStateOf(duplicateExternal)).toBe('23505');
  }, 60_000);

  it('IT-LEDGER-06: no máximo um lançamento de wallet por transação', async () => {
    const { wallet } = await openWallet('100.00');
    const bet = await runtime.submit.execute({
      providerId: 'provider-a',
      externalTransactionId: `e-${uuidv7()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'r',
      gameId: 'g',
      kind: 'BET' as never,
      money: { amount: '10.00', currency: 'BRL' },
      idempotencyKey: `k-${uuidv7()}`,
      channel: 'http',
      correlationId: `corr-${uuidv7()}`,
    });

    const [leg] = await runtime.sql<{ journal_id: string; wallet_version: string }>(
      `SELECT journal_id::text AS journal_id, wallet_version::text AS wallet_version
         FROM ledger_entries WHERE transaction_id = $1 AND wallet_id IS NOT NULL`,
      [bet.transactionId],
    );

    let duplicateLeg: unknown;
    try {
      await runtime.sql(
        `INSERT INTO ledger_entries (
           id, journal_id, transaction_id, wallet_id, account_id, direction, amount,
           currency, balance_before, balance_after, wallet_version)
         VALUES ($1,$2,$3,$4,NULL,'DEBIT',1.00,'BRL',100.00,99.00,99)`,
        [uuidv7(), leg.journal_id, bet.transactionId, wallet.id],
      );
    } catch (error) {
      duplicateLeg = error;
    }
    expect(sqlStateOf(duplicateLeg)).toBe('23505');
  }, 60_000);
});
