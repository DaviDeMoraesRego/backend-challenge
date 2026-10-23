import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SQL } from 'bun';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../src/contexts/wagering/infrastructure/messaging/sqs.client';
import { uuidv7 } from '../../src/shared/ids/uuid7';
import { api, betBody, type ApiResponse } from '../helpers/api-client';
import {
  AppCluster,
  type ClusterInstance,
} from '../helpers/app-cluster';
import { assertLedgerMatchesBalance } from '../helpers/assert-ledger';
import { eventually } from '../helpers/eventually';
import { createTestRuntime, type TestRuntime } from '../helpers/infra';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '../helpers/isolated-db';
import { TestQueues } from '../helpers/sqs-queues';

const TX_QUEUE = 'wager-tx-cluster.fifo';
const TX_DLQ = 'wager-tx-cluster-dlq.fifo';
const EVENTS_QUEUE = 'wager-events-cluster.fifo';
const EVENTS_DLQ = 'wager-events-cluster-dlq.fifo';

let db: IsolatedDatabase;
let rt: TestRuntime;
let sqs: SQSClient;
let queues: TestQueues;
let cluster: AppCluster | null = null;
let txUrl = '';
let txDlqUrl = '';
let eventsUrl = '';
const touchedWallets: string[] = [];

async function createWallet(amount = '100.00', currency = 'BRL') {
  const response = await api<{ id: string; playerId: string }>(
    cluster!.urls()[0],
    'POST',
    '/wallets',
    { playerId: uuidv7(), initialBalance: { amount, currency } },
  );
  expect(response.status).toBe(201);
  touchedWallets.push(response.body.id);
  return response.body;
}

async function submitOn(
  instance: ClusterInstance,
  walletId: string,
  playerId: string,
  overrides: {
    kind?: string;
    amount?: string;
    currency?: string;
    reference?: string;
    key?: string;
    ext?: string;
  } = {},
): Promise<ApiResponse<Record<string, unknown>>> {
  const externalTransactionId = overrides.ext ?? `${overrides.kind ?? 'BET'}-${uuidv7()}`;
  return api(
    instance.url,
    'POST',
    '/wagering/transactions',
    betBody({
      playerId,
      walletId,
      externalTransactionId,
      kind: overrides.kind,
      amount: overrides.amount,
      currency: overrides.currency,
      referenceExternalTransactionId: overrides.reference,
    }),
    { 'Idempotency-Key': overrides.key ?? `provider-a:${externalTransactionId}` },
  );
}

async function collectEventsUntil(
  done: (events: Array<Record<string, unknown>>) => boolean,
  timeoutMs: number,
) {
  const collected: Array<Record<string, unknown>> = [];
  await eventually(
    async () => {
      collected.push(...(await queues.consumeAll(eventsUrl, 3)));
      expect(done(collected)).toBe(true);
    },
    { timeoutMs, intervalMs: 500, message: 'eventos publicados na fila' },
  );
  return collected;
}

beforeAll(async () => {
  db = await createIsolatedDatabase('it_cluster');
  await db.migrate();
  rt = await createTestRuntime(db.appUrl);
  sqs = createSqsClient({
    endpoint: rt.config.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    region: rt.config.env.AWS_REGION,
    accessKeyId: 'test',
    secretAccessKey: 'test',
  });
  queues = new TestQueues(sqs);
  txUrl = await queues.ensure(TX_QUEUE, { VisibilityTimeout: '10' });
  txDlqUrl = await queues.ensure(TX_DLQ);
  eventsUrl = await queues.ensure(EVENTS_QUEUE, { VisibilityTimeout: '10' });
  await queues.ensure(EVENTS_DLQ);

  cluster = await AppCluster.start({
    instances: 3,
    basePort: 3121,
    databaseUrl: db.appUrl,
    sqsEndpoint: rt.config.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    transactionsQueueUrl: txUrl,
    transactionsDlqUrl: txDlqUrl,
    eventsQueueUrl: eventsUrl,
  });
}, 300_000);

afterAll(async () => {
  await cluster?.stop();
  await assertLedgerMatchesBalance(rt.orm, touchedWallets);
  await queues.destroyAll();
  await rt.close();
  await db.drop();
}, 180_000);

describe('Cluster real de 3 instâncias (CC-04/06/07/08, CR-03, CR-04)', () => {
  it('CC-04: mix HTTP + SQS na mesma wallet via 3 instâncias sem lost update', async () => {
    const wallet = await createWallet('100.00');
    await queues.drain(txUrl);

    for (let index = 0; index < 6; index += 1) {
      const response = await submitOn(
        cluster!.roundRobin(index),
        wallet.id,
        wallet.playerId,
        { amount: '1.00' },
      );
      expect(response.status).toBe(201);
    }

    for (let index = 0; index < 4; index += 1) {
      const externalTransactionId = `sqs-${uuidv7()}`;
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: txUrl,
          MessageBody: JSON.stringify({
            messageId: `msg-${uuidv7()}`,
            type: 'WagerTransactionRequested',
            occurredAt: new Date().toISOString(),
            data: {
              providerId: 'provider-a',
              externalTransactionId,
              idempotencyKey: `provider-a:${externalTransactionId}`,
              playerId: wallet.playerId,
              walletId: wallet.id,
              roundId: 'round-cluster',
              gameId: 'fortune-chimp',
              kind: 'BET',
              money: { amount: '1.00', currency: 'BRL' },
            },
          }),
          MessageGroupId: wallet.id,
          MessageDeduplicationId: `dedup-${uuidv7()}`,
        }),
      );
    }

    await eventually(
      async () => {
        const depth = await queues.depth(txUrl);
        expect(depth.visible + depth.inFlight).toBe(0);
      },
      { timeoutMs: 60_000, intervalMs: 300, message: 'comandos SQS consumidos' },
    );

    const ledger = await rt.listLedger.execute(wallet.id, { limit: 100 });
    const debits = ledger?.entries.filter((entry) => entry.direction === 'DEBIT') ?? [];
    expect(debits).toHaveLength(10);
    const stored = await rt.getWallet.execute(wallet.id);
    expect(stored?.balance.amount).toBe('90.00');
    await assertLedgerMatchesBalance(rt.orm, [wallet.id]);
  }, 180_000);

  it('CC-06: 3 publishers concorrentes publicam todos os eventos sem perda', async () => {
    await queues.drain(eventsUrl);
    const wallet = await createWallet('100.00');
    const transactionIds = new Set<string>();

    for (let index = 0; index < 8; index += 1) {
      const response = await submitOn(cluster!.roundRobin(index), wallet.id, wallet.playerId, {
        amount: '1.00',
      });
      expect(response.status).toBe(201);
      transactionIds.add(String(response.body.transactionId));
    }

    // 8 transações ⇒ 8 WagerTransactionProcessed + 8 WalletBalanceChanged
    const events = await collectEventsUntil((collected) => {
      const processed = collected.filter(
        (event) =>
          event.eventType === 'WagerTransactionProcessed' &&
          transactionIds.has(String(event.aggregateId)),
      );
      return processed.length === 8;
    }, 90_000);
    const mine = events.filter((event) => transactionIds.has(String(event.aggregateId)));
    const processed = mine.filter((event) => event.eventType === 'WagerTransactionProcessed');
    expect(processed).toHaveLength(8);
    expect(new Set(processed.map((event) => String(event.aggregateId))).size).toBe(8);

    const balanceChanged = events.filter(
      (event) =>
        event.eventType === 'WalletBalanceChanged' &&
        transactionIds.has(String((event.data as { transactionId?: string })?.transactionId)),
    );
    expect(balanceChanged).toHaveLength(8);
    expect(new Set(mine.map((event) => String(event.eventId))).size).toBe(mine.length);
  }, 180_000);

  it('CC-07: REFUND chega antes da BET e é liquidado pelo worker após a referência', async () => {
    const wallet = await createWallet('100.00');
    const reference = `bet-late-${uuidv7()}`;
    const refundExternalId = `refund-late-${uuidv7()}`;

    const refund = await submitOn(cluster!.instances[0], wallet.id, wallet.playerId, {
      kind: 'REFUND',
      amount: '5.00',
      reference,
      ext: refundExternalId,
    });
    expect(refund.status).toBe(202);
    expect(refund.body.status).toBe('PENDING_REFERENCE');

    const bet = await api(
      cluster!.instances[1].url,
      'POST',
      '/wagering/transactions',
      betBody({
        playerId: wallet.playerId,
        walletId: wallet.id,
        externalTransactionId: reference,
        amount: '5.00',
      }),
      { 'Idempotency-Key': `provider-a:${reference}` },
    );
    expect(bet.status).toBe(201);

    await eventually(
      async () => {
        const resolved = await api(
          cluster!.instances[2].url,
          'GET',
          `/providers/provider-a/wagering/transactions/${refundExternalId}`,
        );
        expect(resolved.status).toBe(200);
        const status = (resolved.body as { status?: string }).status;
        expect(status).toBe('PROCESSED');
      },
      { timeoutMs: 60_000, intervalMs: 300, message: 'REFUND pendente liquidado' },
    );

    const stored = await rt.getWallet.execute(wallet.id);
    expect(stored?.balance.amount).toBe('100.00');
    await assertLedgerMatchesBalance(rt.orm, [wallet.id]);
  }, 180_000);

  it('CC-08: BRL e USD do mesmo player em paralelo mantêm invariantes por moeda', async () => {
    const playerId = uuidv7();
    const brl = await api<{ id: string }>(cluster!.urls()[0], 'POST', '/wallets', {
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const usd = await api<{ id: string }>(cluster!.urls()[1], 'POST', '/wallets', {
      playerId,
      initialBalance: { amount: '100.00', currency: 'USD' },
    });
    expect(brl.status).toBe(201);
    expect(usd.status).toBe(201);
    touchedWallets.push(brl.body.id, usd.body.id);

    // BRL e USD em paralelo; a segunda aposta em BRL vem depois para o cenário ser
    // determinístico (a primeira consome 30 de 100, a de 90 não cabe)
    const parallel = await Promise.all([
      submitOn(cluster!.instances[0], brl.body.id, playerId, { amount: '30.00', currency: 'BRL' }),
      submitOn(cluster!.instances[1], usd.body.id, playerId, { amount: '40.00', currency: 'USD' }),
    ]);
    expect(parallel[0].status, JSON.stringify(parallel[0].body)).toBe(201);
    expect(parallel[1].status, JSON.stringify(parallel[1].body)).toBe(201);

    const overflow = await submitOn(cluster!.instances[2], brl.body.id, playerId, {
      amount: '90.00',
      currency: 'BRL',
    });
    expect(overflow.status, JSON.stringify(overflow.body)).toBe(422);

    const brlStored = await rt.getWallet.execute(brl.body.id);
    const usdStored = await rt.getWallet.execute(usd.body.id);
    expect(brlStored?.balance.amount).toBe('70.00');
    expect(usdStored?.balance.amount).toBe('60.00');

    const [imbalance] = await rt.sql<{ currency: string; net: string }>(
      `SELECT j.currency::text AS currency,
              SUM(CASE WHEN e.direction = 'DEBIT' THEN e.amount ELSE -e.amount END)::text AS net
         FROM journals j JOIN ledger_entries e ON e.journal_id = j.id
        GROUP BY j.currency ORDER BY j.currency`,
    );
    expect(Number(imbalance.net)).toBe(0);
    await assertLedgerMatchesBalance(rt.orm, [brl.body.id, usd.body.id]);
  }, 180_000);

  it('CR-03: SIGKILL de 1 das 3 instâncias + restart mantém o serviço e a consistência', async () => {
    const wallet = await createWallet('100.00');
    await cluster!.kill(1);

    const duringOutage = await Promise.all([
      submitOn(cluster!.instances[0], wallet.id, wallet.playerId, { amount: '10.00' }),
      submitOn(cluster!.instances[2], wallet.id, wallet.playerId, { amount: '20.00' }),
    ]);
    expect(duringOutage.map((response) => response.status).sort()).toEqual([201, 201]);

    await cluster!.restart(1);
    const afterRestart = await submitOn(cluster!.instances[1], wallet.id, wallet.playerId, {
      amount: '5.00',
    });
    expect(afterRestart.status).toBe(201);

    const stored = await rt.getWallet.execute(wallet.id);
    expect(stored?.balance.amount).toBe('65.00');
    await assertLedgerMatchesBalance(rt.orm, [wallet.id]);
  }, 180_000);

  it('CR-04: queda transitória do PostgreSQL é classificada e o retry idempotente não duplica', async () => {
    const wallet = await createWallet('100.00');

    const inFlight = Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        submitOn(cluster!.roundRobin(index), wallet.id, wallet.playerId, { amount: '1.00' }),
      ),
    );
    // derruba as conexões da aplicação: os in-flight viram 503 (transitório)
    const killer = new SQL(db.migratorUrl);
    try {
      await killer.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = current_database() AND usename = 'wagering_app'
            AND pid <> pg_backend_pid()`,
      );
    } finally {
      await killer.close();
    }

    const responses = await inFlight;
    for (const response of responses) {
      // 201 (commitou antes da queda) ou 503 (transitório classificado) — nunca 500
      expect([201, 503], JSON.stringify(response.body)).toContain(response.status);
    }

    // retry idempotente da MESMA requisição: um único débito no fim
    const ext = `crash-pg-${uuidv7()}`;
    const key = `provider-a:${ext}`;
    const first = await submitOn(cluster!.instances[0], wallet.id, wallet.playerId, {
      amount: '2.00',
      ext,
      key,
    });
    expect([201, 503], JSON.stringify(first.body)).toContain(first.status);
    const retry = await submitOn(cluster!.instances[1], wallet.id, wallet.playerId, {
      amount: '2.00',
      ext,
      key,
    });
    expect([201, 503], JSON.stringify(retry.body)).toContain(retry.status);

    await eventually(
      async () => {
        const stored = await rt.getWallet.execute(wallet.id);
        const ledger = await rt.listLedger.execute(wallet.id, { limit: 200 });
        const debits = ledger?.entries.filter((entry) => entry.direction === 'DEBIT') ?? [];
        const total = debits.reduce((sum, entry) => sum + Number(entry.money.amount), 0);
        const expected = Number((100 - Number(stored?.balance.amount)).toFixed(2));
        expect(total).toBe(expected);
        // a transação de 2.00 aparece no máximo uma vez no ledger
        expect(debits.filter((entry) => entry.money.amount === '2.00')).toHaveLength(
          expected >= 2 ? 1 : 0,
        );
      },
      { timeoutMs: 60_000, intervalMs: 500, message: 'estado final estável' },
    );

    await assertLedgerMatchesBalance(rt.orm, [wallet.id]);
  }, 180_000);
});
