import type { OutboxMessage } from '../../domain/outbox/outbox-message';
import type { OutboxMessage as OutboxMessageType } from '../../domain/outbox/outbox-message';
import type {
  Clock,
  EventPublisher,
  LoggerPort,
  MetricsPort,
} from '../../application/ports/misc-ports';
import type { TransactionRunner } from '../../application/ports/unit-of-work';

export interface OutboxPublisherOptions {
  readonly pollMs: number;
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly faultInjectionEnabled: boolean;
  readonly crashAfterClaim: boolean;
  readonly crashAfterPublish: boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Transactional outbox publisher (ADR-05): claim em tx curta com lease
 * (SKIP LOCKED), publicação **fora** da tx, marca/backoff em tx curta.
 * Crash entre publish e mark gera republicação deduplicada por `eventId`.
 */
export class OutboxPublisher {
  private stopping = false;
  private started = false;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
    private readonly options: OutboxPublisherOptions,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.loopPromise = this.loop();
    this.logger.info({ batchSize: this.options.batchSize }, 'outbox publisher iniciado');
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopping = true;
    if (this.loopPromise) await this.loopPromise;
    this.started = false;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        const result = await this.runOnce();
        if (result.published === 0 && result.failed === 0) {
          await sleep(this.options.pollMs);
        }
      } catch (error) {
        this.logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          'ciclo do outbox publisher falhou',
        );
        await sleep(this.options.pollMs);
      }
    }
  }

  async runOnce(): Promise<{ published: number; failed: number; claimed: number }> {
    const messages = await this.runner.run(async (uow) =>
      uow.outbox.claimDue(this.options.batchSize, this.options.leaseMs),
    );

    if (messages.length === 0) {
      await this.refreshGauges();
      return { published: 0, failed: 0, claimed: 0 };
    }

    // Só faz sentido simular o crash quando havia trabalho: o cenário é "lease
    // órfão", não "publisher morre em loop sem nada para publicar".
    if (this.options.faultInjectionEnabled && this.options.crashAfterClaim) {
      this.logger.warn(
        { claimed: messages.length },
        'FAULT_CRASH_AFTER_CLAIM_OUTBOX: lease órfão simulado',
      );
      process.kill(process.pid, 'SIGKILL');
    }

    // O `claimDue` devolve as linhas em `ORDER BY id` (UUIDv7 é cronológico) e o
    // agrupamento por `aggregateId` preserva essa ordem relativa dentro do grupo.
    const groups = new Map<string, OutboxMessageType[]>();
    for (const message of messages) {
      const list = groups.get(message.aggregateId) ?? [];
      list.push(message);
      groups.set(message.aggregateId, list);
    }

    let published = 0;
    let failed = 0;

    for (const list of groups.values()) {
      // ids publicados neste grupo: marcados em UM UPDATE ao final do grupo.
      const publishedIds: string[] = [];
      try {
        for (const message of list) {
          try {
            await this.publisher.publish(message);
            if (this.options.faultInjectionEnabled && this.options.crashAfterPublish) {
              this.logger.warn(
                { eventId: message.id },
                'FAULT_CRASH_AFTER_PUBLISH_BEFORE_MARK: matando processo',
              );
              process.kill(process.pid, 'SIGKILL');
            }
            publishedIds.push(message.id);
            this.metrics.recordOutboxPublish('ok');
            published += 1;
          } catch (error) {
            const now = this.clock.now();
            message.scheduleRetry(now, { maxAttempts: this.options.maxAttempts });
            await this.runner.run(async (uow) =>
              uow.outbox.scheduleRetry(message.id, message.attempts, message.nextAttemptAt),
            );
            const poisoned = message.attempts >= this.options.maxAttempts;
            this.metrics.recordOutboxPublish(poisoned ? 'poison' : 'retry');
            failed += 1;
            this.logger.error(
              {
                eventId: message.id,
                attempts: message.attempts,
                nextAttemptAt: message.nextAttemptAt.toISOString(),
                poisoned,
                error: error instanceof Error ? error.message : String(error),
              },
              poisoned
                ? 'evento envenenado na outbox (intervenção manual)'
                : 'falha ao publicar evento — backoff agendado',
            );
            break; // preserva a ordem por agregado
          }
        }
      } finally {
        if (publishedIds.length > 0) {
          const now = this.clock.now();
          await this.runner.run(async (uow) =>
            uow.outbox.markPublishedMany(publishedIds, now),
          );
        }
      }
    }

    await this.refreshGauges();
    return { published, failed, claimed: messages.length };
  }

  private async refreshGauges(): Promise<void> {
    try {
      const now = this.clock.now();
      const lag = await this.runner.run(async (uow) => uow.outbox.lag());
      this.metrics.setOutboxBacklog(lag.backlog);
      this.metrics.setOutboxLag(
        lag.oldestCreatedAt
          ? Math.max(0, (now.getTime() - lag.oldestCreatedAt.getTime()) / 1000)
          : 0,
      );
    } catch {
      // métrica é best-effort
    }
  }
}

export type { OutboxMessage };
