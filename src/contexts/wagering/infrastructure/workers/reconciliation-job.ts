import { Money } from '../../domain/money/money';
import type {
  Clock,
  LoggerPort,
  MetricsPort,
} from '../../application/ports/misc-ports';
import type { TransactionRunner } from '../../application/ports/unit-of-work';

export interface ReconciliationJobOptions {
  readonly sweepMs: number;
  readonly batchSize: number;
}

export interface ReconciliationJobResult {
  readonly skipped: boolean;
  readonly walletsChecked: number;
  readonly divergentWallets: number;
  readonly imbalances: Array<{ currency: string; net: string }>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const LOCK_KEY = 'wagering-reconciliation';

/**
 * Varredura periódica (ADR-11): exclusividade multi-instância via
 * `pg_try_advisory_xact_lock` (lock de varredura, nunca de dados), lotes por keyset
 * e Σ=0 por moeda. Divergência → métrica + log; **nunca** corrige.
 */
export class ReconciliationJob {
  private stopping = false;
  private started = false;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly clock: Clock,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
    private readonly options: ReconciliationJobOptions,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.loopPromise = this.loop();
    this.logger.info(
      { sweepMs: this.options.sweepMs, batchSize: this.options.batchSize },
      'reconciliation job iniciado',
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
          'ciclo da reconciliação falhou',
        );
      }
      await sleep(this.options.sweepMs);
    }
  }

  async runOnce(): Promise<ReconciliationJobResult> {
    return this.runner.run(async (uow) => {
      const lock = await uow.session.queryOne<{ locked: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked`,
        [LOCK_KEY],
      );
      if (!lock?.locked) {
        this.logger.info({}, 'outra instância já executa a varredura — ciclo ignorado');
        return {
          skipped: true,
          walletsChecked: 0,
          divergentWallets: 0,
          imbalances: [],
        };
      }

      let cursor: string | null = null;
      let walletsChecked = 0;
      let divergentWallets = 0;

      for (;;) {
        const wallets = await uow.wallets.pageAfter(cursor, this.options.batchSize);
        if (wallets.length === 0) break;

        const aggregates = await uow.ledger.aggregateByWallets(
          wallets.map((wallet) => wallet.id),
        );

        for (const wallet of wallets) {
          const aggregate = aggregates.get(wallet.id);
          const calculated = Money.of(aggregate?.sum ?? '0.00', wallet.currency);
          if (!calculated.equals(wallet.balance)) {
            divergentWallets += 1;
            this.metrics.recordReconciliationDivergence('job');
            this.logger.error(
              {
                walletId: wallet.id,
                storedBalance: wallet.balance.toString(),
                calculatedBalance: calculated.toString(),
                source: 'job',
              },
              'divergência de saldo detectada pela varredura (não corrigida)',
            );
          }
          this.metrics.recordReconciliationChecked('job', aggregate?.entries ?? 0);
        }

        walletsChecked += wallets.length;
        cursor = wallets[wallets.length - 1].id;
        if (wallets.length < this.options.batchSize) break;
      }

      const imbalances = await uow.ledger.journalImbalanceByCurrency();
      for (const imbalance of imbalances) {
        if (Number(imbalance.net) !== 0) {
          this.metrics.recordReconciliationDivergence('job');
          this.logger.error(
            { currency: imbalance.currency, net: imbalance.net },
            'Σ débitos ≠ Σ créditos em uma moeda (partida dobrada violada)',
          );
        }
      }

      this.logger.info(
        { walletsChecked, divergentWallets, imbalances },
        'varredura de reconciliação concluída',
      );

      return {
        skipped: false,
        walletsChecked,
        divergentWallets,
        imbalances,
      };
    });
  }
}
