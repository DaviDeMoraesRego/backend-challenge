import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv, type AppConfig } from '../../src/config/env';
import { SubmitWagerTransaction } from '../../src/contexts/wagering/application/use-cases/submit-wager-transaction';
import { OpenWallet } from '../../src/contexts/wagering/application/use-cases/open-wallet';
import { SqsEventPublisher } from '../../src/contexts/wagering/infrastructure/messaging/sqs-event-publisher';
import { SqsPoller } from '../../src/contexts/wagering/infrastructure/messaging/sqs-poller';
import { createSqsClient } from '../../src/contexts/wagering/infrastructure/messaging/sqs.client';
import { MikroTransactionRunner } from '../../src/contexts/wagering/infrastructure/persistence/mikro-transaction-runner';
import { buildOrmConfig } from '../../src/contexts/wagering/infrastructure/persistence/mikro-orm.config';
import { PromMetrics } from '../../src/contexts/wagering/infrastructure/observability/metrics/metrics.registry';
import { NoopTracer } from '../../src/contexts/wagering/infrastructure/observability/tracing/tracing';
import { OutboxPublisher } from '../../src/contexts/wagering/infrastructure/workers/outbox-publisher';
import { systemClock } from '../../src/shared/clock/system-clock';
import { uuidv7 } from '../../src/shared/ids/uuid7';
import { assertLedgerMatchesBalance } from '../helpers/assert-ledger';
import { eventually } from '../helpers/eventually';
import { TEST_DATABASE_URL, migrateTestSchema } from '../helpers/infra';
import { RecordingLogger } from '../helpers/silent-logger';

const EVENTS_QUEUE = 'wager-events-it.fifo';
const EVENTS_DLQ = 'wager-events-it-dlq.fifo';
const TX_QUEUE = 'wager-transactions-it.fifo';
const TX_DLQ = 'wager-transactions-it-dlq.fifo';

let orm: MikroORM;
let sqs: SQSClient;
let config: AppConfig;
let metrics: PromMetrics;
let logger: RecordingLogger;
let runner: MikroTransactionRunner;
let submit: SubmitWagerTransaction;
let publisher: OutboxPublisher;
let openWalletUseCase: OpenWallet;
let eventsQueueUrl = '';
let txQueueUrl = '';
let txDlqUrl = '';

const touchedWallets: string[] = [];

const queueUrl = async (name: string): Promise<string> => {
  const response = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  return response.QueueUrl as string;
};

beforeAll(async () => {
  await migrateTestSchema();
  config = loadEnv({
    ...process.env,
    DATABASE_URL: TEST_DATABASE_URL,
    AUTH_ENABLED: 'false',
    SQS_ENDPOINT: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  });
  sqs = createSqsClient({
    endpoint: config.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    region: config.env.AWS_REGION,
    accessKeyId: 'test',
    secretAccessKey: 'test',
  });
  orm = await MikroORM.init(buildOrmConfig(TEST_DATABASE_URL, 8));
  metrics = new PromMetrics('it-messaging', 'it-messaging');
  logger = new RecordingLogger();
  runner = new MikroTransactionRunner(
    orm,
    {
      lockTimeoutMs: config.env.LOCK_TIMEOUT_MS,
      statementTimeoutMs: config.env.STATEMENT_TIMEOUT_MS,
      idleTxTimeoutMs: config.env.IDLE_TX_TIMEOUT_MS,
      maxRetries: config.env.TX_MAX_RETRIES,
    },
    metrics,
    logger,
  );
  submit = new SubmitWagerTransaction(
    runner,
    systemClock,
    { next: () => uuidv7() },
    { isAllowed: (providerId) => config.providers.has(providerId) },
    config.currencies,
    new NoopTracer(),
    metrics,
    logger,
  );
  openWalletUseCase = new OpenWallet(
    runner,
    systemClock,
    { next: () => uuidv7() },
    config.currencies,
    new NoopTracer(),
    [...config.currencies][0],
  );
  eventsQueueUrl = await queueUrl(EVENTS_QUEUE);
  await queueUrl(EVENTS_DLQ);
  txQueueUrl = await queueUrl(TX_QUEUE);
  txDlqUrl = await queueUrl(TX_DLQ);

  publisher = new OutboxPublisher(
    runner,
    new SqsEventPublisher(sqs, eventsQueueUrl),
    systemClock,
    metrics,
    logger,
    {
      pollMs: 200,
      batchSize: 50,
      leaseMs: 30_000,
      maxAttempts: 25,
      faultInjectionEnabled: false,
      crashAfterClaim: false,
      crashAfterPublish: false,
    },
  );
}, 120_000);

afterAll(async () => {
  if (orm) await assertLedgerMatchesBalance(orm, touchedWallets);
  for (const name of [EVENTS_QUEUE, EVENTS_DLQ, TX_QUEUE, TX_DLQ]) {
    try {
      const url = await queueUrl(name);
      await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
    } catch {
      // melhor esforço na limpeza
    }
  }
  await orm?.close(true);
}, 120_000);

/** Consome e apaga mensagens existentes (limpeza determinística da fila). */
async function drainQueue(url: string): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
      }),
    );
    const messages = received.Messages ?? [];
    for (const message of messages) {
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: url,
          ReceiptHandle: message.ReceiptHandle as string,
        }),
      );
    }
    if (messages.length < 10) return;
  }
}

async function openWallet(amount = '1000.00') {
  const playerId = uuidv7();
  const wallet = await openWalletUseCase.execute({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
    correlationId: `corr-${uuidv7()}`,
  });
  touchedWallets.push(wallet.id);
  return { walletId: wallet.id, playerId };
}

describe('Mensageria — outbox → SQS e consumer (IT-OUTBOX / IT-SQS)', () => {
  it('IT-OUTBOX-01/02/06: eventos só existem após commit e são publicados com dedup por eventId', async () => {
    // 1) escoa o backlog de execuções anteriores (publicados ou em backoff)
    for (let round = 0; round < 50; round += 1) {
      const run = await publisher.runOnce();
      if (run.claimed === 0) break;
    }
    // 2) fila limpa para asserção determinística
    await drainQueue(eventsQueueUrl);

    const { walletId, playerId } = await openWallet('100.00');
    const externalTransactionId = `ext-${uuidv7()}`;

    const result = await submit.execute({
      providerId: 'provider-a',
      externalTransactionId,
      playerId,
      walletId,
      roundId: 'round-outbox',
      gameId: 'fortune-chimp',
      kind: 'BET' as never,
      money: { amount: '10.00', currency: 'BRL' },
      idempotencyKey: `provider-a:${externalTransactionId}`,
      channel: 'http',
      correlationId: `corr-${uuidv7()}`,
    });
    expect(String(result.status)).toBe('PROCESSED');

    // 3) eventos desta transação estão pendentes na outbox (nada saiu antes do commit)
    const [unpublishedBefore] = await runner.run(async (uow) =>
      uow.session.query<{ pending: number }>(
        `SELECT COUNT(*)::int AS pending FROM outbox_messages
          WHERE published_at IS NULL AND aggregate_id IN ($1, $2)`,
        [result.transactionId, walletId],
      ),
    );
    expect(unpublishedBefore.pending).toBeGreaterThanOrEqual(2);

    // 4) publica (outras suítes podem rodar em paralelo ⇒ publica até sair tudo)
    let publishedTotal = 0;
    for (let round = 0; round < 50; round += 1) {
      const run = await publisher.runOnce();
      publishedTotal += run.published;
      const [stillPending] = await runner.run(async (uow) =>
        uow.session.query<{ pending: number }>(
          `SELECT COUNT(*)::int AS pending FROM outbox_messages
            WHERE published_at IS NULL AND aggregate_id IN ($1, $2)`,
          [result.transactionId, walletId],
        ),
      );
      if (stillPending.pending === 0) break;
      if (run.claimed === 0) break;
    }
    expect(publishedTotal).toBeGreaterThanOrEqual(2);

    // 5) procura os nossos eventos na fila; mensagens de outras suítes são descartadas
    //    para liberar espaço (outras suítes rodam em paralelo e publicam na mesma fila).
    let processed: Record<string, any> | undefined;
    let balanceChanged: Record<string, any> | undefined;
    for (let round = 0; round < 60; round += 1) {
      const received = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: eventsQueueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
        }),
      );
      const messages = received.Messages ?? [];
      if (messages.length === 0 && (processed || balanceChanged)) break;
      for (const message of messages) {
        const body = JSON.parse(message.Body ?? '{}') as Record<string, any>;
        const ours =
          (body.eventType === 'WagerTransactionProcessed' &&
            body.aggregateId === result.transactionId) ||
          (body.eventType === 'WalletBalanceChanged' &&
            body.aggregateId === walletId &&
            body.data?.transactionId === result.transactionId);
        if (ours) {
          if (body.eventType === 'WagerTransactionProcessed') processed = body;
          else balanceChanged = body;
        }
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: eventsQueueUrl,
            ReceiptHandle: message.ReceiptHandle as string,
          }),
        );
      }
      if (processed && balanceChanged) break;
    }

    expect(processed).toBeDefined();
    expect(processed?.data.money).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(processed?.version).toBe(1);

    expect(balanceChanged).toBeDefined();
    expect(balanceChanged?.data.balanceAfter).toEqual({
      amount: '90.00',
      currency: 'BRL',
    });

    // marcação de publicado apenas para os eventos desta transação
    const unpublished = await runner.run(async (uow) =>
      uow.session.query<{ pending: number }>(
        `SELECT COUNT(*)::int AS pending FROM outbox_messages
          WHERE published_at IS NULL AND aggregate_id IN ($1, $2)`,
        [result.transactionId, walletId],
      ),
    );
    expect(unpublished[0].pending).toBe(0);

    await assertLedgerMatchesBalance(orm, [walletId]);
  }, 120_000);

  it('IT-SQS-01/02: consumer processa mensagem, dedupa por inbox e faz ack', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    const messageId = `msg-${uuidv7()}`;
    const externalTransactionId = `ext-${uuidv7()}`;

    const poller = new SqsPoller(
      sqs,
      submit,
      metrics,
      logger,
      {
        queueUrl: txQueueUrl,
        dlqUrl: txDlqUrl,
        queueLabel: TX_QUEUE,
        concurrency: 4,
        waitTimeSeconds: 1,
        visibilityTimeoutSeconds: 5,
        graceMs: 2_000,
        faultInjectionEnabled: false,
        crashAfterCommitBeforeAck: false,
      },
      null,
    );
    poller.start();

    try {
      const body = JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: systemClock.now().toISOString(),
        data: {
          providerId: 'provider-a',
          externalTransactionId,
          idempotencyKey: `provider-a:${externalTransactionId}`,
          playerId,
          walletId,
          roundId: 'round-sqs',
          gameId: 'fortune-chimp',
          kind: 'BET',
          money: { amount: '30.00', currency: 'BRL' },
        },
      });

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: txQueueUrl,
          MessageBody: body,
          MessageGroupId: walletId,
          MessageDeduplicationId: messageId,
        }),
      );

      await eventually(
        async () => {
          const attributes = await sqs.send(
            new GetQueueAttributesCommand({
              QueueUrl: txQueueUrl,
              AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
            }),
          );
          const visible = Number(
            attributes.Attributes?.ApproximateNumberOfMessages ?? '0',
          );
          const inFlight = Number(
            attributes.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0',
          );
          expect(visible + inFlight).toBe(0);
        },
        { timeoutMs: 30_000, message: 'mensagem consumida e ackada' },
      );

      const [inbox] = await runner.run(async (uow) =>
        uow.session.query<{ processed_at: string | null }>(
          `SELECT processed_at FROM inbox_messages WHERE consumer_name = 'wager-transactions' AND message_id = $1`,
          [messageId],
        ),
      );
      expect(inbox).toBeDefined();
      expect(inbox.processed_at).not.toBeNull();

      const [transaction] = await runner.run(async (uow) =>
        uow.session.query<{ status: string }>(
          `SELECT status FROM wager_transactions WHERE provider_id = 'provider-a' AND external_transaction_id = $1`,
          [externalTransactionId],
        ),
      );
      expect(transaction.status).toBe('PROCESSED');

      // redelivery da mesma mensagem → inbox dedup, sem efeito duplo
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: txQueueUrl,
          MessageBody: body,
          MessageGroupId: walletId,
          MessageDeduplicationId: `${messageId}-redelivery`,
        }),
      );
      await eventually(
        async () => {
          const attributes = await sqs.send(
            new GetQueueAttributesCommand({
              QueueUrl: txQueueUrl,
              AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
            }),
          );
          const visible = Number(attributes.Attributes?.ApproximateNumberOfMessages ?? '0');
          const inFlight = Number(
            attributes.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0',
          );
          expect(visible + inFlight).toBe(0);
        },
        { timeoutMs: 30_000, message: 'redelivery ackada' },
      );

      const [legs] = await runner.run(async (uow) =>
        uow.session.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
          [walletId],
        ),
      );
      expect(legs.count).toBe(1);

      await assertLedgerMatchesBalance(orm, [walletId]);
    } finally {
      await poller.stop();
    }
  }, 180_000);

  it('IT-SQS-05: payload malformado vai para a DLQ explícita e não bloqueia o grupo', async () => {
    const poller = new SqsPoller(
      sqs,
      submit,
      metrics,
      logger,
      {
        queueUrl: txQueueUrl,
        dlqUrl: txDlqUrl,
        queueLabel: TX_QUEUE,
        concurrency: 2,
        waitTimeSeconds: 1,
        visibilityTimeoutSeconds: 5,
        graceMs: 2_000,
        faultInjectionEnabled: false,
        crashAfterCommitBeforeAck: false,
      },
      null,
    );
    poller.start();

    try {
      const poisonId = `poison-${uuidv7()}`;
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: txQueueUrl,
          MessageBody: '{"isso":"nao-e-um-envelope-valido"}',
          MessageGroupId: `group-${uuidv7()}`,
          MessageDeduplicationId: poisonId,
        }),
      );

      await eventually(
        async () => {
          const dlq = await sqs.send(
            new ReceiveMessageCommand({
              QueueUrl: txDlqUrl,
              MaxNumberOfMessages: 10,
              WaitTimeSeconds: 1,
            }),
          );
          expect((dlq.Messages ?? []).length).toBeGreaterThan(0);
        },
        { timeoutMs: 30_000, message: 'mensagem permanente na DLQ' },
      );
    } finally {
      await poller.stop();
    }
  }, 120_000);
});
