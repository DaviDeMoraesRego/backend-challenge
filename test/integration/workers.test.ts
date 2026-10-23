import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { PromMetrics } from '../../src/contexts/wagering/infrastructure/observability/metrics/metrics.registry';
import { buildOrmConfig } from '../../src/contexts/wagering/infrastructure/persistence/mikro-orm.config';
import { executeSql } from '../../src/contexts/wagering/infrastructure/persistence/sql-session';
import { PendingReferenceWorker } from '../../src/contexts/wagering/infrastructure/workers/pending-reference-worker';
import { ReconciliationJob } from '../../src/contexts/wagering/infrastructure/workers/reconciliation-job';
import { RetentionJob } from '../../src/contexts/wagering/infrastructure/workers/retention-job';
import { systemClock } from '../../src/shared/clock/system-clock';
import { uuidv7 } from '../../src/shared/ids/uuid7';
import { assertLedgerMatchesBalance } from '../helpers/assert-ledger';
import { eventually } from '../helpers/eventually';
import { createTestRuntime, submitCommand, type TestRuntime } from '../helpers/infra';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '../helpers/isolated-db';
import { RecordingLogger } from '../helpers/silent-logger';

let db: IsolatedDatabase;
let rt: TestRuntime;
let migratorOrm: MikroORM;
let metrics: PromMetrics;
let logger: RecordingLogger;
const touchedWallets: string[] = [];

async function openWallet(amount = '100.00', currency = 'BRL') {
  const playerId = uuidv7();
  const wallet = await rt.openWallet.execute({
    playerId,
    initialBalance: { amount, currency },
    correlationId: `corr-${uuidv7()}`,
  });
  touchedWallets.push(wallet.id);
  return { walletId: wallet.id, playerId };
}

beforeAll(async () => {
  db = await createIsolatedDatabase('it_workers');
  await db.migrate();
  rt = await createTestRuntime(db.appUrl);
  migratorOrm = await MikroORM.init(buildOrmConfig(db.migratorUrl, 2));
  metrics = new PromMetrics('it-workers', 'it-workers');
  logger = new RecordingLogger();
}, 180_000);

afterAll(async () => {
  await assertLedgerMatchesBalance(rt.orm, touchedWallets);
  await migratorOrm.close(true);
  await rt.close();
  await db.drop();
}, 120_000);

describe('Workers — pending reference, retenção e reconciliação (IT-PEND / IT-RET / IT-RECON-JOB)', () => {
  it('IT-PEND-05: dois workers concorrentes reclamam conjuntos disjuntos (SKIP LOCKED)', async () => {
    for (let index = 0; index < 6; index += 1) {
      const { walletId, playerId } = await openWallet('100.00');
      const result = await rt.submit.execute(
        submitCommand({
          playerId,
          walletId,
          kind: 'REFUND',
          amount: '10.00',
          referenceExternalTransactionId: `ghost-${uuidv7()}`,
          externalTransactionId: `pend-${uuidv7()}`,
        }),
      );
      expect(String(result.status)).toBe('PENDING_REFERENCE');
    }

    // criações novas nascem com backoff agendado; o tempo faria o mesmo
    await rt.sql(
      `UPDATE wager_transactions SET next_attempt_at = now() - interval '1 second'
        WHERE status = 'PENDING_REFERENCE'`,
    );

    const worker = new PendingReferenceWorker(
      rt.runner,
      rt.settle,
      metrics,
      logger,
      { next: () => uuidv7() },
      { pollMs: 100, batchSize: 3, leaseMs: 30_000 },
    );

    const [first, second] = await Promise.all([
      rt.runner.run(async (uow) => uow.transactions.claimPendingReference(3, 30_000)),
      rt.runner.run(async (uow) => uow.transactions.claimPendingReference(3, 30_000)),
    ]);

    const ids = [...first.map((claim) => claim.id), ...second.map((claim) => claim.id)];
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);

    // o worker real roda sobre os claims sem duplicar efeito
    const claimed = await worker.runOnce();
    expect(claimed).toBe(0);
  }, 120_000);

  it('IT-RET-01/02: retenção apaga apenas outbox publicada > 7d e inbox processada > 14d', async () => {
    const oldPublished = uuidv7();
    const recentPublished = uuidv7();
    const pending = uuidv7();
    const oldProcessed = `msg-old-${uuidv7()}`;
    const oldUnprocessed = `msg-new-${uuidv7()}`;

    await rt.sql(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at,
         attempts, next_attempt_at, published_at)
       VALUES ($1, $2, 'Old', '{}'::jsonb, now() - interval '9 days', 1, now(), now() - interval '8 days'),
              ($3, $4, 'Recent', '{}'::jsonb, now(), 1, now(), now() - interval '1 hour'),
              ($5, $6, 'Pending', '{}'::jsonb, now(), 0, now(), NULL)`,
      [oldPublished, uuidv7(), recentPublished, uuidv7(), pending, uuidv7()],
    );
    await rt.sql(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES ('wager-transactions', $1, 'hash', now() - interval '20 days', now() - interval '15 days'),
              ('wager-transactions', $2, 'hash', now() - interval '20 days', NULL)`,
      [oldProcessed, oldUnprocessed],
    );

    const job = new RetentionJob(rt.runner, metrics, logger, {
      intervalMs: 60_000,
      outboxRetentionDays: 7,
      inboxRetentionDays: 14,
      batchSize: 500,
    });
    const result = await job.runOnce();
    expect(result.outbox).toBeGreaterThanOrEqual(1);
    expect(result.inbox).toBeGreaterThanOrEqual(1);

    const remaining = await rt.sql<{ id: string }>(
      `SELECT id::text AS id FROM outbox_messages
        WHERE id::text = ANY(string_to_array($1::text, ','))`,
      [[recentPublished, pending].join(',')],
    );
    expect(remaining).toHaveLength(2);

    const [oldRow] = await rt.sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM outbox_messages WHERE id = $1`,
      [oldPublished],
    );
    expect(oldRow.count).toBe(0);

    const inboxRows = await rt.sql<{ message_id: string }>(
      `SELECT message_id FROM inbox_messages WHERE message_id IN ($1, $2)`,
      [oldProcessed, oldUnprocessed],
    );
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0].message_id).toBe(oldUnprocessed);
  }, 120_000);

  it('IT-RET-03: role da aplicação apaga outbox/inbox mas é negada no ledger', async () => {
    const [privileges] = await rt.sql<{
      app_can_update_ledger: boolean;
      app_can_delete_ledger: boolean;
      app_can_delete_outbox: boolean;
      app_can_delete_inbox: boolean;
    }>(
      `SELECT has_table_privilege('wagering_app', 'ledger_entries', 'UPDATE') AS app_can_update_ledger,
              has_table_privilege('wagering_app', 'ledger_entries', 'DELETE') AS app_can_delete_ledger,
              has_table_privilege('wagering_app', 'outbox_messages', 'DELETE') AS app_can_delete_outbox,
              has_table_privilege('wagering_app', 'inbox_messages', 'DELETE') AS app_can_delete_inbox`,
    );
    expect(privileges.app_can_update_ledger).toBe(false);
    expect(privileges.app_can_delete_ledger).toBe(false);
    expect(privileges.app_can_delete_outbox).toBe(true);
    expect(privileges.app_can_delete_inbox).toBe(true);

    const { walletId, playerId } = await openWallet('50.00');
    await rt.submit.execute(
      submitCommand({ playerId, walletId, externalTransactionId: `del-${uuidv7()}`, amount: '5.00' }),
    );
    const [entry] = await rt.sql<{ id: string }>(
      `SELECT id::text AS id FROM ledger_entries WHERE wallet_id = $1 LIMIT 1`,
      [walletId],
    );
    await expect(
      rt.sql(`DELETE FROM ledger_entries WHERE id = $1`, [entry.id]),
    ).rejects.toThrow(/ledger is immutable|permission denied/);
  }, 60_000);

  it('IT-RECON-JOB-01/03: varredura em lotes detecta divergência e mantém Σ=0 por moeda', async () => {
    for (let index = 0; index < 5; index += 1) await openWallet('30.00');
    await openWallet('30.00', 'USD');

    const job = new ReconciliationJob(rt.runner, systemClock, metrics, logger, {
      sweepMs: 60_000,
      batchSize: 2,
    });

    const started = performance.now();
    const clean = await job.runOnce();
    const elapsedMs = performance.now() - started;

    expect(clean.skipped).toBe(false);
    expect(clean.walletsChecked).toBeGreaterThanOrEqual(6);
    expect(clean.divergentWallets).toBe(0);
    for (const imbalance of clean.imbalances) {
      expect(Number(imbalance.net)).toBe(0);
    }
    expect(clean.imbalances.map((item) => item.currency).sort()).toEqual(['BRL', 'USD']);
    expect(elapsedMs).toBeLessThan(30_000);

    const { walletId } = await openWallet('40.00');
    const em = migratorOrm.em.fork();
    await executeSql(em, `ALTER TABLE wallets DISABLE TRIGGER trg_wallet_balance_consistency`);
    try {
      await executeSql(em, `UPDATE wallets SET balance = balance + 1 WHERE id = $1`, [walletId]);
      const dirty = await job.runOnce();
      expect(dirty.divergentWallets).toBeGreaterThanOrEqual(1);
    } finally {
      await executeSql(em, `UPDATE wallets SET balance = balance - 1 WHERE id = $1`, [walletId]);
      await executeSql(em, `ALTER TABLE wallets ENABLE TRIGGER trg_wallet_balance_consistency`);
    }

    const restored = await job.runOnce();
    expect(restored.divergentWallets).toBe(0);
    await assertLedgerMatchesBalance(rt.orm, [walletId]);
  }, 120_000);

  it('IT-RECON-JOB-02: advisory lock garante que apenas uma instância varre por vez', async () => {
    const job = new ReconciliationJob(rt.runner, systemClock, metrics, logger, {
      sweepMs: 60_000,
      batchSize: 100,
    });

    let locked = false;
    const holder = rt.runner.run(async (uow) => {
      const [row] = await uow.session.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtext('wagering-reconciliation')) AS locked`,
      );
      locked = row.locked;
      await new Promise((resolve) => setTimeout(resolve, 700));
    });

    await eventually(() => {
      expect(locked).toBe(true);
    }, { timeoutMs: 10_000, intervalMs: 50, message: 'lock de varredura adquirido' });

    const whileLocked = await job.runOnce();
    expect(whileLocked.skipped).toBe(true);
    expect(whileLocked.walletsChecked).toBe(0);

    await holder;

    const afterRelease = await job.runOnce();
    expect(afterRelease.skipped).toBe(false);
    expect(afterRelease.walletsChecked).toBeGreaterThan(0);
  }, 60_000);
});
