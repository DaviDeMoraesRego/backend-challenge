import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../src/contexts/wagering/infrastructure/messaging/sqs.client';
import { uuidv7 } from '../../src/shared/ids/uuid7';
import { api } from '../helpers/api-client';
import { AppCluster } from '../helpers/app-cluster';
import { assertLedgerMatchesBalance } from '../helpers/assert-ledger';
import { eventually } from '../helpers/eventually';
import { createTestRuntime, type TestRuntime } from '../helpers/infra';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '../helpers/isolated-db';
import { TestQueues } from '../helpers/sqs-queues';

const TX_QUEUE = 'wager-tx-crash.fifo';
const TX_DLQ = 'wager-tx-crash-dlq.fifo';
const EVENTS_QUEUE = 'wager-events-crash.fifo';
const EVENTS_DLQ = 'wager-events-crash-dlq.fifo';

let db: IsolatedDatabase;
let rt: TestRuntime;
let sqs: SQSClient;
let queues: TestQueues;
let txUrl = '';
let txDlqUrl = '';
let eventsUrl = '';
const started: AppCluster[] = [];
const touchedWallets: string[] = [];

const baseOptions = () => ({
  databaseUrl: db.appUrl,
  sqsEndpoint: rt.config.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  transactionsQueueUrl: txUrl,
  transactionsDlqUrl: txDlqUrl,
  eventsQueueUrl: eventsUrl,
});

async function startCluster(
  port: number,
  role: string,
  envByIndex: Record<number, Record<string, string>> = {},
): Promise<AppCluster> {
  const cluster = await AppCluster.start({
    ...baseOptions(),
    instances: 1,
    basePort: port,
    role,
    envByIndex,
    readyTimeoutMs: 45_000,
  });
  started.push(cluster);
  return cluster;
}

async function waitForDeath(url: string): Promise<void> {
  await eventually(
    async () => {
      try {
        const response = await fetch(`${url}/health/live`, {
          signal: AbortSignal.timeout(1_000),
        });
        throw new Error(`ainda vivo (${response.status})`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('ainda vivo')) throw error;
        return;
      }
    },
    { timeoutMs: 30_000, intervalMs: 200, message: 'processo morreu (fault injection)' },
  );
}

/** Esvazia a outbox para que o publisher do cluster com fault só veja o evento do teste. */
async function drainOutbox(): Promise<void> {
  await rt.sql(`UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL`);
}

/** Cria a wallet direto no banco: o crash do publisher não deve derrubar o setup. */
async function openWalletDirect(amount = '100.00') {
  const playerId = uuidv7();
  const wallet = await rt.openWallet.execute({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
    correlationId: `corr-${uuidv7()}`,
  });
  touchedWallets.push(wallet.id);
  return { walletId: wallet.id, playerId };
}

async function createWallet(url: string, amount = '100.00') {
  const playerId = uuidv7();
  const response = await api<{ id: string; playerId: string }>(url, 'POST', '/wallets', {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(response.status).toBe(201);
  touchedWallets.push(response.body.id);
  return { walletId: response.body.id, playerId };
}

beforeAll(async () => {
  db = await createIsolatedDatabase('it_crash');
  await db.migrate();
  rt = await createTestRuntime(db.appUrl);
  sqs = createSqsClient({
    endpoint: rt.config.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    region: rt.config.env.AWS_REGION,
    accessKeyId: 'test',
    secretAccessKey: 'test',
  });
  queues = new TestQueues(sqs);
  txUrl = await queues.ensure(TX_QUEUE, { VisibilityTimeout: '5' });
  txDlqUrl = await queues.ensure(TX_DLQ);
  eventsUrl = await queues.ensure(EVENTS_QUEUE, { VisibilityTimeout: '5' });
  await queues.ensure(EVENTS_DLQ);
}, 300_000);

afterAll(async () => {
  for (const cluster of started) await cluster.stop().catch(() => undefined);
  await assertLedgerMatchesBalance(rt.orm, touchedWallets);
  await queues.destroyAll();
  await rt.close();
  await db.drop();
}, 180_000);

describe('Falhas de processo com fault injection (CR-01/02/02b)', () => {
  it('CR-01: consumer morto após o commit e antes do ack → redelivery com inbox dedup, 1 débito', async () => {
    const clusterA = await startCluster(3141, 'api,sqs-consumer', {
      0: {
        FAULT_INJECTION_ENABLED: 'true',
        FAULT_CRASH_AFTER_COMMIT_BEFORE_ACK: 'true',
      },
    });
    const wallet = await createWallet(clusterA.urls()[0], '100.00');
    await queues.drain(txUrl);

    const messageId = `crash-${uuidv7()}`;
    const externalTransactionId = `crash-${uuidv7()}`;
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: txUrl,
        MessageBody: JSON.stringify({
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'provider-a',
            externalTransactionId,
            idempotencyKey: `provider-a:${externalTransactionId}`,
            playerId: wallet.playerId,
            walletId: wallet.walletId,
            roundId: 'round-crash',
            gameId: 'fortune-chimp',
            kind: 'BET',
            money: { amount: '10.00', currency: 'BRL' },
          },
        }),
        MessageGroupId: wallet.walletId,
        MessageDeduplicationId: messageId,
      }),
    );

    await waitForDeath(clusterA.urls()[0]);

    // o efeito foi commitado antes do crash
    const [committed] = await rt.sql<{ status: string; processed_at: string | null }>(
      `SELECT status, processed_at::text FROM wager_transactions WHERE external_transaction_id = $1`,
      [externalTransactionId],
    );
    expect(committed.status).toBe('PROCESSED');
    const [inbox] = await rt.sql<{ processed_at: string | null }>(
      `SELECT processed_at::text FROM inbox_messages WHERE message_id = $1`,
      [messageId],
    );
    expect(inbox.processed_at).not.toBeNull();

    // outra instância redelivera a mensagem após o VisibilityTimeout e apenas acka
    const clusterB = await startCluster(3142, 'api,sqs-consumer');
    await eventually(
      async () => {
        const depth = await queues.depth(txUrl);
        expect(depth.visible + depth.inFlight).toBe(0);
      },
      { timeoutMs: 90_000, intervalMs: 500, message: 'redelivery ackada pela outra instância' },
    );

    const ledger = await rt.listLedger.execute(wallet.walletId, { limit: 50 });
    const debits = ledger?.entries.filter((entry) => entry.direction === 'DEBIT') ?? [];
    expect(debits).toHaveLength(1);
    const stored = await rt.getWallet.execute(wallet.walletId);
    expect(stored?.balance.amount).toBe('90.00');
    await assertLedgerMatchesBalance(rt.orm, [wallet.walletId]);
    await clusterB.stop();
  }, 240_000);

  it('CR-02: publisher morto após publicar e antes de marcar → republicação deduplicada por eventId', async () => {
    await queues.drain(eventsUrl);
    await drainOutbox();
    const clusterA = await startCluster(3143, 'api,outbox-publisher', {
      0: {
        FAULT_INJECTION_ENABLED: 'true',
        FAULT_CRASH_AFTER_PUBLISH_BEFORE_MARK: 'true',
      },
    });
    const wallet = await openWalletDirect('50.00');
    await waitForDeath(clusterA.urls()[0]);

    const clusterB = await startCluster(3144, 'api,outbox-publisher');

    await eventually(
      async () => {
        const [pending] = await rt.sql<{ pending: number }>(
          `SELECT COUNT(*)::int AS pending FROM outbox_messages
            WHERE published_at IS NULL AND aggregate_id::text = ANY(string_to_array($1::text, ','))`,
          [[wallet.walletId].join(',')],
        );
        const [walletEvents] = await rt.sql<{ pending: number }>(
          `SELECT COUNT(*)::int AS pending FROM outbox_messages
            WHERE published_at IS NULL
              AND payload::text LIKE '%' || $1 || '%'`,
          [wallet.walletId],
        );
        expect(pending.pending + walletEvents.pending).toBe(0);
      },
      { timeoutMs: 90_000, intervalMs: 500, message: 'outbox republicada e marcada' },
    );

    const events = await queues.consumeAll(eventsUrl, 10);
    const opening = events.filter(
      (event) => event.eventType === 'WagerTransactionProcessed' || event.eventType === 'WalletBalanceChanged',
    );
    expect(opening.length).toBeGreaterThanOrEqual(1);
    // dedup do broker: cada eventId aparece uma única vez
    expect(new Set(events.map((event) => String(event.eventId))).size).toBe(events.length);
    await assertLedgerMatchesBalance(rt.orm, [wallet.walletId]);
    await clusterB.stop();
  }, 240_000);

  it('CR-02b: publisher morto após o claim → lease expira e outra instância assume', async () => {
    await queues.drain(eventsUrl);
    await drainOutbox();
    const clusterA = await startCluster(3145, 'api,outbox-publisher', {
      0: {
        FAULT_INJECTION_ENABLED: 'true',
        FAULT_CRASH_AFTER_CLAIM_OUTBOX: 'true',
      },
    });
    const wallet = await openWalletDirect('20.00');
    await waitForDeath(clusterA.urls()[0]);

    const clusterB = await startCluster(3146, 'api,outbox-publisher', {
      0: { OUTBOX_LEASE_MS: '1000', OUTBOX_POLL_MS: '200' },
    });

    await eventually(
      async () => {
        const [row] = await rt.sql<{ pending: number }>(
          `SELECT COUNT(*)::int AS pending FROM outbox_messages
            WHERE published_at IS NULL AND payload::text LIKE '%' || $1 || '%'`,
          [wallet.walletId],
        );
        expect(row.pending).toBe(0);
      },
      { timeoutMs: 90_000, intervalMs: 400, message: 'lease órfão retomado' },
    );

    const events = await queues.consumeAll(eventsUrl, 10);
    expect(events.length).toBeGreaterThanOrEqual(1);
    await assertLedgerMatchesBalance(rt.orm, [wallet.walletId]);
    await clusterB.stop();
  }, 240_000);
});
