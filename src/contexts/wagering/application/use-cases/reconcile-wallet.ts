import { Money, type MoneyProps } from '../../domain/money/money';
import type { LoggerPort, MetricsPort } from '../ports/misc-ports';
import type { TransactionRunner } from '../ports/unit-of-work';

export interface ReconciliationResult {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
  readonly chainBreaks: number;
}

export type ReconcileSource = 'endpoint' | 'job';

/**
 * Reconciliação por wallet (ADR-11): agregação + verificação de cadeia.
 * Divergências **nunca** são corrigidas — apenas métrica + log + resposta.
 */
export class ReconcileWallet {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
  ) {}

  async execute(
    walletId: string,
    source: ReconcileSource = 'endpoint',
    providerId: string | null = null,
  ): Promise<ReconciliationResult | null> {
    return this.runner.run(async (uow) => {
      const wallet = await uow.wallets.findById(walletId);
      if (!wallet) return null;
      if (providerId !== null && wallet.providerId !== providerId) return null;

      const aggregate = await uow.ledger.sumByWallet(walletId);
      const chainBreaks = await uow.ledger.chainCheck(walletId);
      const calculated = Money.of(aggregate.sum, wallet.currency);
      const difference = wallet.balance.subtract(calculated);
      const balanceConsistent = difference.isZero();
      const consistent = balanceConsistent && chainBreaks === 0;

      this.metrics.recordReconciliationChecked(source, aggregate.entries);
      if (!consistent) {
        this.metrics.recordReconciliationDivergence(source);
        this.logger.error(
          {
            walletId,
            source,
            storedBalance: wallet.balance.toString(),
            calculatedBalance: calculated.toString(),
            difference: difference.toString(),
            chainBreaks,
            checkedEntries: aggregate.entries,
          },
          'divergência de reconciliação detectada (não corrigida)',
        );
      }

      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: aggregate.entries,
        chainBreaks,
      };
    });
  }
}
