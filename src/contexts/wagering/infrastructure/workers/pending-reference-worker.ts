import type {
  IdGenerator,
  LoggerPort,
  MetricsPort,
} from '../../application/ports/misc-ports';
import type { TransactionRunner } from '../../application/ports/unit-of-work';
import type { SettleWagerTransaction } from '../../application/use-cases/settle-wager-transaction';

export interface PendingReferenceWorkerOptions {
  readonly pollMs: number;
  readonly batchSize: number;
  readonly leaseMs: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sweep de PENDING_REFERENCE (ADR-07): claim com lease via SKIP LOCKED, então
 * reprocessa cada transação pelo mesmo núcleo de settlement.
 */
export class PendingReferenceWorker {
  private stopping = false;
  private started = false;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly settle: SettleWagerTransaction,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
    private readonly ids: IdGenerator,
    private readonly options: PendingReferenceWorkerOptions,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.loopPromise = this.loop();
    this.logger.info(
      { batchSize: this.options.batchSize },
      'pending-reference worker iniciado',
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
        const claims = await this.runOnce();
        if (claims === 0) await sleep(this.options.pollMs);
      } catch (error) {
        this.logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          'ciclo do pending-reference worker falhou',
        );
        await sleep(this.options.pollMs);
      }
    }
  }

  async runOnce(): Promise<number> {
    const claims = await this.runner.run(async (uow) =>
      uow.transactions.claimPendingReference(
        this.options.batchSize,
        this.options.leaseMs,
      ),
    );

    for (const claim of claims) {
      try {
        const result = await this.settle.execute({
          transactionId: claim.id,
          correlationId: this.ids.next(),
          causationId: 'pending-reference-sweep',
        });
        this.logger.info(
          {
            transactionId: claim.id,
            outcome: result.outcome,
            previousAttempts: claim.attempts,
          },
          'transação pendente reavaliada',
        );
      } catch (error) {
        this.logger.error(
          {
            transactionId: claim.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'falha ao reprocessar transação pendente',
        );
      }
    }

    try {
      const backlog = await this.runner.run(async (uow) =>
        uow.transactions.countPendingReference(),
      );
      this.metrics.setPendingBacklog(backlog);
    } catch {
      // métrica é best-effort
    }

    return claims.length;
  }
}
