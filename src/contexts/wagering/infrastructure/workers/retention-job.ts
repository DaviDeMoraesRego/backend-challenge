import type { LoggerPort, MetricsPort } from '../../application/ports/misc-ports';
import type { TransactionRunner } from '../../application/ports/unit-of-work';

export interface RetentionJobOptions {
  readonly intervalMs: number;
  readonly outboxRetentionDays: number;
  readonly inboxRetentionDays: number;
  readonly batchSize: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retenção de outbox/inbox (Req. F): DELETE em lotes por `ctid`, apenas linhas
 * publicadas/processadas. Nunca toca ledger/journals (role da app não tem permissão).
 */
export class RetentionJob {
  private stopping = false;
  private started = false;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
    private readonly options: RetentionJobOptions,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.loopPromise = this.loop();
    this.logger.info(
      {
        outboxRetentionDays: this.options.outboxRetentionDays,
        inboxRetentionDays: this.options.inboxRetentionDays,
      },
      'retention job iniciado',
    );
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
        await this.runOnce();
      } catch (error) {
        this.logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          'ciclo da retenção falhou',
        );
      }
      await sleep(this.options.intervalMs);
    }
  }

  async runOnce(): Promise<{ outbox: number; inbox: number }> {
    const outbox = await this.purgeOutbox();
    const inbox = await this.purgeInbox();
    return { outbox, inbox };
  }

  private async purgeOutbox(): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.runner.run(async (uow) => {
        const row = await uow.session.queryOne<{ deleted: number }>(
          `WITH del AS (
             DELETE FROM outbox_messages
              WHERE ctid IN (
                SELECT ctid FROM outbox_messages
                 WHERE published_at IS NOT NULL
                   AND published_at < now() - make_interval(days => $1::int)
                 LIMIT $2
              )
              RETURNING 1
           )
           SELECT COUNT(*)::int AS deleted FROM del`,
          [this.options.outboxRetentionDays, this.options.batchSize],
        );
        return Number(row?.deleted ?? 0);
      });
      total += deleted;
      this.metrics.recordRetentionDeleted('outbox_messages', deleted);
      if (deleted < this.options.batchSize) break;
    }
    if (total > 0) {
      this.logger.info({ deleted: total }, 'retenção da outbox aplicada');
    }
    return total;
  }

  private async purgeInbox(): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.runner.run(async (uow) => {
        const row = await uow.session.queryOne<{ deleted: number }>(
          `WITH del AS (
             DELETE FROM inbox_messages
              WHERE ctid IN (
                SELECT ctid FROM inbox_messages
                 WHERE processed_at IS NOT NULL
                   AND processed_at < now() - make_interval(days => $1::int)
                 LIMIT $2
              )
              RETURNING 1
           )
           SELECT COUNT(*)::int AS deleted FROM del`,
          [this.options.inboxRetentionDays, this.options.batchSize],
        );
        return Number(row?.deleted ?? 0);
      });
      total += deleted;
      this.metrics.recordRetentionDeleted('inbox_messages', deleted);
      if (deleted < this.options.batchSize) break;
    }
    if (total > 0) {
      this.logger.info({ deleted: total }, 'retenção do inbox aplicada');
    }
    return total;
  }
}
