import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { SubmitWagerTransaction } from '../../src/contexts/wagering/application/use-cases/submit-wager-transaction';
import { createSqsClient } from '../../src/contexts/wagering/infrastructure/messaging/sqs.client';
import { SqsPoller } from '../../src/contexts/wagering/infrastructure/messaging/sqs-poller';
import { systemClock } from '../../src/shared/clock/system-clock';
import { uuidv7 } from '../../src/shared/ids/uuid7';
import { assertLedgerMatchesBalance } from '../helpers/assert-ledger';
import { eventually } from '../helpers/eventually';
import { createTestRuntime, type TestRuntime } from '../helpers/infra';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '../helpers/isolated-db';
import { TestQueues } from '../helpers/sqs-queues';

const QUEUE = 'wager-tx-it-behavior.fifo';
const DLQ = 'wager-tx-it-behavior-dlq.fifo';
const REDRIVE_QUEUE = 'wager-tx-it-redrive.fifo';
const REDRIVE_DLQ = 'wager-tx-it-redrive-dlq.fifo';

let db: IsolatedDatabase;
let rt: TestRuntime;
let sqs: SQSClient;
let queues: TestQueues;
let queueUrl = '';
let dlqUrl = '';
let redriveUrl = '';
let redriveDlqUrl = '';
const touchedWallets: string[] = [];

/** Substitui o use case apenas para induzir classes de erro determinísticas. */
const submitStub = (
  impl: (command: unknown) => Promise<unknown>,
): SubmitWagerTransaction => ({ execute: impl }) as unknown as SubmitWagerTransaction;

const pollerFor = (
  submit: SubmitWagerTransaction,
  queue: string,
  dlq: string,
  overrides: Partial<ConstructorParameters<typeof SqsPoller>[4]> = {},
): SqsPoller =>
  new SqsPoller(sqs, submit, rt.metrics, rt.logger, {
    queueUrl: queue,
    dlqUrl: dlq,
    queueLabel: QUEUE,
    concurrency: 2,
    waitTimeSeconds: 1,
    visibilityTimeoutSeconds: 2,
    graceMs: 2_000,
    faultInjectionEnabled: false,
    crashAfterCommitBeforeAck: false,
    ...overrides,
  });

let envelopeSeq = 0;
function envelope(props: {
  walletId: string;
  playerId: string;
  externalTransactionId?: string;
  kind?: string;
  amount?: string;
  providerId?: string;
  referenceExternalTransactionId?: string;
  messageId?: string;
}) {
  const externalTransactionId = props.externalTransactionId ?? `sqs-${uuidv7()}`;
  envelopeSeq += 1;
  return {
    externalTransactionId,
    messageId: props.messageId ?? `msg-${uuidv7()}-${envelopeSeq}`,
    body: {
      messageId: props.messageId ?? `msg-${uuidv7()}-${envelopeSeq}`,
      type: 'WagerTransactionRequested',
      occurredAt: systemClock.now().toISOString(),
      data: {
        providerId: props.providerId ?? 'provider-a',
        externalTransactionId,
        idempotencyKey: `${props.providerId ?? 'provider-a'}:${externalTransactionId}`,
        playerId: props.playerId,
        walletId: props.walletId,
        roundId: 'round-sqs',
        gameId: 'fortune-chimp',
        kind: props.kind ?? 'BET',
        money: { amount: props.amount ?? '10.00', currency: 'BRL' },
        ...(props.referenceExternalTransactionId
          ? { referenceExternalTransactionId: props.referenceExternalTransactionId }
          : {}),
      },
    },
  };
}

async function send(url: string, body: unknown, groupId: string, dedupId: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: dedupId,
    }),
  );
}

async function openWallet(amount = '100.00') {
  const playerId = uuidv7();
  const wallet = await rt.openWallet.execute({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
    correlationId: `corr-${uuidv7()}`,
  });
  touchedWallets.push(wallet.id);
  return { walletId: wallet.id, playerId };
}

beforeAll(async () => {
  db = await createIsolatedDatabase('it_sqs');
  await db.migrate();
  rt = await createTestRuntime(db.appUrl);
  sqs = createSqsClient({
    endpoint: rt.config.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    region: rt.config.env.AWS_REGION,
    accessKeyId: 'test',
    secretAccessKey: 'test',
  });
  queues = new TestQueues(sqs);
  queueUrl = await queues.ensure(QUEUE, { VisibilityTimeout: '2' });
  dlqUrl = await queues.ensure(DLQ);
  const redrive = await queues.ensureWithRedrive(REDRIVE_QUEUE, REDRIVE_DLQ, 2);
  redriveUrl = redrive.url;
  redriveDlqUrl = redrive.dlqUrl;
}, 180_000);

afterAll(async () => {
  await assertLedgerMatchesBalance(rt.orm, touchedWallets);
  await queues.destroyAll();
  await rt.close();
  await db.drop();
}, 120_000);

describe('Consumer SQS — classes de erro, redrive e shutdown (IT-SQS-03/04/06/07/08)', () => {
  it('IT-SQS-03: erro transitório devolve a visibilidade e a mensagem é reprocessada', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    const { externalTransactionId, messageId, body } = envelope({ walletId, playerId });
    let calls = 0;

    const flaky = submitStub(async (command) => {
      calls += 1;
      if (calls <= 2) {
        const error = new Error('lock not available (55P03)');
        Object.assign(error, { code: '55P03' });
        throw error;
      }
      return rt.submit.execute(command as Parameters<SubmitWagerTransaction['execute']>[0]);
    });

    const poller = pollerFor(flaky, queueUrl, dlqUrl);
    poller.start();
    try {
      await send(queueUrl, body, walletId, messageId);

      await eventually(
        async () => {
          const depth = await queues.depth(queueUrl);
          expect(depth.visible + depth.inFlight).toBe(0);
        },
        { timeoutMs: 60_000, intervalMs: 250, message: 'mensagem drenada' },
      );

      expect(calls).toBeGreaterThanOrEqual(3);
      const transaction = await rt.getTransactionByExternalId.execute(
        'provider-a',
        externalTransactionId,
      );
      expect(String(transaction?.status)).toBe('PROCESSED');
      await assertLedgerMatchesBalance(rt.orm, [walletId]);
    } finally {
      await poller.stop();
    }
  }, 120_000);

  it('IT-SQS-04: falhas transitórias esgotadas acionam o redrive nativo para a DLQ', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    const { body, messageId } = envelope({ walletId, playerId });

    const alwaysTransient = submitStub(async () => {
      const error = new Error('timeout ao conectar no PostgreSQL');
      Object.assign(error, { code: 'ETIMEDOUT' });
      throw error;
    });

    const poller = pollerFor(alwaysTransient, redriveUrl, redriveDlqUrl, {
      visibilityTimeoutSeconds: 1,
    });
    poller.start();
    try {
      await send(redriveUrl, body, walletId, messageId);
      await eventually(
        async () => {
          const depth = await queues.depth(redriveDlqUrl);
          expect(depth.visible + depth.inFlight).toBeGreaterThanOrEqual(1);
        },
        { timeoutMs: 90_000, intervalMs: 500, message: 'mensagem redirecionada para a DLQ' },
      );

      const dead = await queues.consumeAll(redriveDlqUrl, 3);
      expect(dead).toHaveLength(1);
      expect(JSON.stringify(dead[0])).toContain('WagerTransactionRequested');
      await assertLedgerMatchesBalance(rt.orm, [walletId]);
    } finally {
      await poller.stop();
    }
  }, 180_000);

  it('IT-SQS-06: OPENING pela fila não é aceito (DLQ explícita, sem efeito financeiro)', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    const { body, messageId, externalTransactionId } = envelope({
      walletId,
      playerId,
      kind: 'OPENING',
      amount: '50.00',
    });

    const poller = pollerFor(rt.submit, queueUrl, dlqUrl);
    poller.start();
    try {
      await send(queueUrl, body, walletId, messageId);
      await eventually(
        async () => {
          const depth = await queues.depth(dlqUrl);
          expect(depth.visible + depth.inFlight).toBeGreaterThanOrEqual(1);
        },
        { timeoutMs: 40_000, intervalMs: 250, message: 'OPENING bloqueado na DLQ' },
      );

      const transaction = await rt.getTransactionByExternalId.execute(
        'provider-a',
        externalTransactionId,
      );
      expect(transaction).toBeNull();

      const wallet = await rt.getWallet.execute(walletId);
      expect(wallet?.balance.amount).toBe('100.00');
      await assertLedgerMatchesBalance(rt.orm, [walletId]);
    } finally {
      await poller.stop();
    }
  }, 120_000);

  it('IT-SQS-07: provider fora da allow-list vira REJECTED UNKNOWN_PROVIDER e é ackado', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    const { body, messageId, externalTransactionId } = envelope({
      walletId,
      playerId,
      providerId: 'provider-x',
    });

    const poller = pollerFor(rt.submit, queueUrl, dlqUrl);
    poller.start();
    try {
      await send(queueUrl, body, walletId, messageId);
      await eventually(
        async () => {
          const depth = await queues.depth(queueUrl);
          expect(depth.visible + depth.inFlight).toBe(0);
        },
        { timeoutMs: 40_000, intervalMs: 250, message: 'rejeição de negócio ackada' },
      );

      const [row] = await rt.sql<{ status: string; failure_code: string }>(
        `SELECT status, failure_code FROM wager_transactions
          WHERE provider_id = 'provider-x' AND external_transaction_id = $1`,
        [externalTransactionId],
      );
      expect(row.status).toBe('REJECTED');
      expect(row.failure_code).toBe('UNKNOWN_PROVIDER');

      const wallet = await rt.getWallet.execute(walletId);
      expect(wallet?.balance.amount).toBe('100.00');
      await assertLedgerMatchesBalance(rt.orm, [walletId]);
    } finally {
      await poller.stop();
    }
  }, 120_000);

  it('IT-SQS-08: stop() com mensagem em voo devolve a visibilidade e nenhum efeito é perdido', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    const { body, messageId, externalTransactionId } = envelope({
      walletId,
      playerId,
      amount: '20.00',
    });

    let handlerStarted = false;
    const slow = submitStub(async (command) => {
      handlerStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return rt.submit.execute(command as Parameters<SubmitWagerTransaction['execute']>[0]);
    });

    const first = pollerFor(slow, queueUrl, dlqUrl, { graceMs: 0, visibilityTimeoutSeconds: 30 });
    first.start();
    await send(queueUrl, body, walletId, messageId);
    await eventually(() => {
      expect(handlerStarted).toBe(true);
    }, { timeoutMs: 20_000, intervalMs: 100, message: 'handler em voo' });

    await first.stop();

    await eventually(
      async () => {
        const depth = await queues.depth(queueUrl);
        expect(depth.visible).toBeGreaterThanOrEqual(1);
      },
      { timeoutMs: 20_000, intervalMs: 200, message: 'visibilidade devolvida no shutdown' },
    );

    const second = pollerFor(rt.submit, queueUrl, dlqUrl);
    second.start();
    try {
      await eventually(
        async () => {
          const transaction = await rt.getTransactionByExternalId.execute(
            'provider-a',
            externalTransactionId,
          );
          expect(String(transaction?.status)).toBe('PROCESSED');
        },
        { timeoutMs: 40_000, intervalMs: 250, message: 'mensagem recuperada por outra instância' },
      );

      const ledger = await rt.listLedger.execute(walletId, { limit: 50 });
      const debits = ledger?.entries.filter((entry) => entry.direction === 'DEBIT') ?? [];
      expect(debits).toHaveLength(1);
      expect(new Set(debits.map((entry) => entry.transactionId)).size).toBe(1);
      await assertLedgerMatchesBalance(rt.orm, [walletId]);
    } finally {
      await second.stop();
    }
  }, 180_000);
});
