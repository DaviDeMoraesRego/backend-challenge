import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { requestContext } from '../observability/als/request-context';
import { resolveCorrelationId } from '../observability/als/correlation';
import type { TraceContext } from '../../domain/outbox/outbox-message';
import type { WagerTransactionKind } from '../../domain/transaction/wager-transaction-kind';
import type { LoggerPort, MetricsPort } from '../../application/ports/misc-ports';
import type { SubmitWagerTransaction } from '../../application/use-cases/submit-wager-transaction';
import type { OpportunisticSettlementTrigger } from '../workers/opportunistic-settlement-trigger';
import { classifyError } from './error-classifier';
import { parseCommandMessage } from './sqs-message-parser';

export interface SqsPollerOptions {
  readonly queueUrl: string;
  readonly dlqUrl: string;
  readonly queueLabel: string;
  readonly concurrency: number;
  readonly waitTimeSeconds: number;
  readonly visibilityTimeoutSeconds: number;
  readonly graceMs: number;
  readonly faultInjectionEnabled: boolean;
  readonly crashAfterCommitBeforeAck: boolean;
  /** exige HMAC válido no envelope (default: false em dev, true em produção). */
  readonly requireSignature?: boolean;
  readonly signingSecret?: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Consumer SQS próprio (ADR-06): long polling, concorrência limitada, ack **apenas
 * após commit**, 3 classes de erro, DLQ explícita, shutdown gracioso com devolução
 * de visibilidade.
 */
export class SqsPoller {
  private stopping = false;
  private started = false;
  private active = 0;
  private loopPromise: Promise<void> | null = null;
  private readonly inflight = new Map<string, string>();

  constructor(
    private readonly client: SQSClient,
    private readonly submit: SubmitWagerTransaction,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
    private readonly options: SqsPollerOptions,
    private readonly kicker: OpportunisticSettlementTrigger | null = null,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.loopPromise = this.loop();
    this.logger.info(
      { queue: this.options.queueLabel, concurrency: this.options.concurrency },
      'consumer SQS iniciado',
    );
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopping = true;
    if (this.loopPromise) await this.loopPromise;
    this.started = false;
    this.logger.info({ queue: this.options.queueLabel }, 'consumer SQS encerrado');
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        const available = Math.max(1, this.options.concurrency - this.active);
        const response = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.options.queueUrl,
            MaxNumberOfMessages: Math.min(available, 10),
            WaitTimeSeconds: this.options.waitTimeSeconds,
            VisibilityTimeout: this.options.visibilityTimeoutSeconds,
            MessageAttributeNames: ['All'],
            MessageSystemAttributeNames: ['All'],
          }),
        );
        for (const message of response.Messages ?? []) {
          this.active += 1;
          this.metrics.setSqsInflight(this.options.queueLabel, this.active);
          void this.process(message).catch((error: unknown) => {
            this.logger.error(
              { error: error instanceof Error ? error.message : String(error) },
              'falha inesperada no handler SQS',
            );
          });
        }
      } catch (error) {
        if (this.stopping) break;
        this.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'ReceiveMessage falhou — aguardando antes de tentar novamente',
        );
        await sleep(500);
      }
    }
    await this.drain();
  }

  /** Grace period: conclui em voo ou devolve a visibilidade (plans/04 §7). */
  private async drain(): Promise<void> {
    const deadline = Date.now() + this.options.graceMs;
    while (this.active > 0 && Date.now() < deadline) {
      await sleep(50);
    }
    for (const [messageId, receiptHandle] of this.inflight.entries()) {
      try {
        await this.changeVisibility(receiptHandle, 0);
        this.logger.warn(
          { messageId },
          'visibilidade devolvida no shutdown (mensagem não concluída)',
        );
      } catch {
        // sem ação: a mensagem será reentregue após o VisibilityTimeout
      }
    }
    this.inflight.clear();
  }

  private async process(message: Message): Promise<void> {
    const startedAt = performance.now();
    const messageId = message.MessageId ?? 'unknown';
    const receiptHandle = message.ReceiptHandle;
    if (receiptHandle) this.inflight.set(messageId, receiptHandle);

    try {
      const parsed = parseCommandMessage(message.Body, {
        requireSignature: this.options.requireSignature ?? false,
        signingSecret: this.options.signingSecret,
      });
      if (!parsed.ok) {
        await this.sendToDeadLetter(message, parsed.reason);
        await this.deleteMessage(receiptHandle);
        this.metrics.recordSqs(this.options.queueLabel, 'dlq');
        this.metrics.recordDlq(this.options.queueLabel);
        this.logger.error(
          { messageId, reason: parsed.reason },
          'mensagem permanente enviada para a DLQ',
        );
        return;
      }

      const envelope = parsed.envelope;
      const correlationId = resolveCorrelationId(
        message.MessageAttributes?.correlationId?.StringValue,
      );
      const traceContext = this.extractTraceContext(message);

      const result = await requestContext.run(
        {
          correlationId,
          messageId: envelope.messageId,
          providerId: envelope.data.providerId,
          walletId: envelope.data.walletId,
        },
        async () =>
          this.submit.execute({
            providerId: envelope.data.providerId,
            externalTransactionId: envelope.data.externalTransactionId,
            playerId: envelope.data.playerId,
            walletId: envelope.data.walletId,
            roundId: envelope.data.roundId,
            gameId: envelope.data.gameId,
            kind: envelope.data.kind as WagerTransactionKind,
            money: envelope.data.money,
            referenceExternalTransactionId:
              envelope.data.referenceExternalTransactionId,
            idempotencyKey: envelope.data.idempotencyKey,
            channel: 'sqs',
            correlationId,
            causationId: envelope.messageId,
            traceContext,
            inbox: { messageId: envelope.messageId, payloadHash: parsed.payloadHash },
          }),
      );

      if (result.transactionId) {
        requestContext.patch({ transactionId: result.transactionId });
      }

      if (
        this.options.faultInjectionEnabled &&
        this.options.crashAfterCommitBeforeAck
      ) {
        this.logger.warn(
          { messageId },
          'FAULT_CRASH_AFTER_COMMIT_BEFORE_ACK: matando processo antes do ack',
        );
        process.kill(process.pid, 'SIGKILL');
        return;
      }

      await this.deleteMessage(receiptHandle);
      this.metrics.recordSqs(this.options.queueLabel, 'ack');

      if (result.settled && this.kicker) {
        void this.kicker
          .kick(result.settled.providerId, result.settled.externalTransactionId)
          .catch(() => undefined);
      }
    } catch (error) {
      await this.handleFailure(message, error);
    } finally {
      this.metrics.observeSqs(
        this.options.queueLabel,
        (performance.now() - startedAt) / 1000,
      );
      this.inflight.delete(messageId);
      this.active = Math.max(0, this.active - 1);
      this.metrics.setSqsInflight(this.options.queueLabel, this.active);
    }
  }

  private async handleFailure(message: Message, error: unknown): Promise<void> {
    const messageId = message.MessageId ?? 'unknown';
    const kind = classifyError(error);

    if (kind === 'business') {
      await this.deleteMessage(message.ReceiptHandle);
      this.metrics.recordSqs(this.options.queueLabel, 'ack');
      this.logger.info(
        { messageId, code: (error as { code?: string }).code },
        'rejeição de negócio já persistida — ack',
      );
      return;
    }

    if (kind === 'permanent') {
      await this.sendToDeadLetter(
        message,
        error instanceof Error ? error.message : String(error),
      );
      await this.deleteMessage(message.ReceiptHandle);
      this.metrics.recordSqs(this.options.queueLabel, 'dlq');
      this.metrics.recordDlq(this.options.queueLabel);
      this.logger.error(
        { messageId, error: error instanceof Error ? error.message : String(error) },
        'erro permanente enviado para a DLQ',
      );
      return;
    }

    const receiveCount = Number(
      message.Attributes?.ApproximateReceiveCount ?? '1',
    );
    const backoffSeconds = Math.min(2 ** Math.min(receiveCount, 5) * 2, 60);
    await this.changeVisibility(message.ReceiptHandle, backoffSeconds);
    this.metrics.recordSqs(this.options.queueLabel, 'retry');
    this.logger.warn(
      { messageId, receiveCount, backoffSeconds },
      'erro transitório — visibilidade alterada com backoff',
    );
  }

  private extractTraceContext(message: Message): TraceContext | null {
    const traceparent = message.MessageAttributes?.traceparent?.StringValue;
    if (!traceparent) return null;
    return {
      traceparent,
      tracestate: message.MessageAttributes?.tracestate?.StringValue,
    };
  }

  private async deleteMessage(receiptHandle: string | undefined): Promise<void> {
    if (!receiptHandle) return;
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  private async changeVisibility(
    receiptHandle: string | undefined,
    timeoutSeconds: number,
  ): Promise<void> {
    if (!receiptHandle) return;
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: timeoutSeconds,
      }),
    );
  }

  private async sendToDeadLetter(message: Message, reason: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.options.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? message.MessageId ?? 'dlq',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          failureReason: { DataType: 'String', StringValue: reason.slice(0, 1000) },
          originalQueue: {
            DataType: 'String',
            StringValue: this.options.queueLabel,
          },
        },
      }),
    );
  }
}
