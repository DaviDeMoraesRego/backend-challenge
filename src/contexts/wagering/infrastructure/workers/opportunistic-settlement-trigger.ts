import { mapWithConcurrency } from '../../../../shared/async/map-with-concurrency';
import type { LoggerPort } from '../../application/ports/misc-ports';
import type { TransactionRunner } from '../../application/ports/unit-of-work';
import type { SettleWagerTransaction } from '../../application/use-cases/settle-wager-transaction';

/** Limite de dependentes liquidados em paralelo por gatilho (protege o pool). */
const DEFAULT_MAX_CONCURRENCY = 4;

/**
 * Gatilho oportunista (ADR-07): após o commit de uma transação PROCESSED, tenta
 * liquidar dependentes PENDING_REFERENCE imediatamente (best-effort, fora da tx).
 * Falhas são ignoradas — o sweep periódico recupera. A concorrência é limitada
 * para não transformar um commit em 100 transações simultâneas no pool.
 */
export class OpportunisticSettlementTrigger {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly settle: SettleWagerTransaction,
    private readonly logger: LoggerPort,
    private readonly maxConcurrency = DEFAULT_MAX_CONCURRENCY,
  ) {}

  async kick(providerId: string, externalTransactionId: string): Promise<void> {
    const ids = await this.runner.run(async (uow) =>
      uow.transactions.findDependentIds(providerId, externalTransactionId),
    );
    await mapWithConcurrency(ids, this.maxConcurrency, async (id) => {
      try {
        await this.settle.execute({ transactionId: id, correlationId: `trigger-${id}` });
      } catch (error: unknown) {
        this.logger.warn(
          {
            transactionId: id,
            error: error instanceof Error ? error.message : String(error),
          },
          'gatilho oportunista falhou (sweep recupera)',
        );
      }
    });
  }
}
