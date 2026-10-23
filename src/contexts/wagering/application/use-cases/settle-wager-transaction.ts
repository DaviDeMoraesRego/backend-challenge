import type { TraceContext } from '../../domain/outbox/outbox-message';
import { FailureCode } from '../../domain/transaction/failure-code';
import type { WagerTransaction } from '../../domain/transaction/wager-transaction';
import { WagerTransactionStatus } from '../../domain/transaction/wager-transaction-status';
import type {
  Clock,
  IdGenerator,
  LoggerPort,
  MetricsPort,
  Tracer,
} from '../ports/misc-ports';
import type { TransactionRunner, UnitOfWork } from '../ports/unit-of-work';
import { persistRejection } from './rejection';
import { executeSettlement } from './settlement-core';

export interface SettleWagerTransactionCommand {
  readonly transactionId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly traceContext?: TraceContext | null;
}

export interface SettleWagerTransactionResult {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus | 'NOT_FOUND';
  readonly outcome: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'ALREADY_FINAL' | 'NOT_FOUND';
}

export interface PendingReferenceSettings {
  readonly maxAttempts: number;
  readonly ttlHours: number;
}

/**
 * Reprocessamento de PENDING_REFERENCE (ADR-07). Reutiliza o mesmo núcleo de
 * settlement do submit; é idempotente por construção (revalida estado sob lock).
 */
export class SettleWagerTransaction {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly tracer: Tracer,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
    private readonly settings: PendingReferenceSettings,
  ) {}

  async execute(
    cmd: SettleWagerTransactionCommand,
  ): Promise<SettleWagerTransactionResult> {
    return this.runner.run(async (uow) => this.runInTransaction(uow, cmd));
  }

  private async runInTransaction(
    uow: UnitOfWork,
    cmd: SettleWagerTransactionCommand,
  ): Promise<SettleWagerTransactionResult> {
    const snapshot = await uow.transactions.findById(cmd.transactionId);
    if (!snapshot) {
      return {
        transactionId: cmd.transactionId,
        status: 'NOT_FOUND',
        outcome: 'NOT_FOUND',
      };
    }
    if (snapshot.isTerminal()) {
      return {
        transactionId: snapshot.id,
        status: snapshot.status,
        outcome: 'ALREADY_FINAL',
      };
    }

    const now = this.clock.now();

    // TTL/attempts esgotados → REJECTED REFERENCE_NOT_FOUND (README §7.1)
    const expired =
      snapshot.attempts >= this.settings.maxAttempts ||
      now.getTime() - snapshot.createdAt.getTime() >
        this.settings.ttlHours * 3_600_000;
    if (expired) {
      const transaction = await uow.transactions.findByIdForUpdate(snapshot.id);
      if (!transaction || transaction.isTerminal()) {
        return {
          transactionId: snapshot.id,
          status: transaction ? transaction.status : 'NOT_FOUND',
          outcome: 'ALREADY_FINAL',
        };
      }
      await persistRejection({
        uow,
        transaction,
        failureCode: FailureCode.ReferenceNotFound,
        resultingBalance: null,
        now,
        ids: this.ids,
        tracer: this.tracer,
        correlationId: cmd.correlationId,
        causationId: cmd.causationId,
      });
      return {
        transactionId: transaction.id,
        status: WagerTransactionStatus.Rejected,
        outcome: 'REJECTED',
      };
    }

    // ordem global de locks: wallet → linha da transação (plans/04 §8.3)
    const wallet = snapshot.walletId
      ? await uow.wallets.findByIdForUpdate(snapshot.walletId)
      : null;

    const transaction = await uow.transactions.findByIdForUpdate(snapshot.id);
    if (!transaction) {
      return {
        transactionId: snapshot.id,
        status: 'NOT_FOUND',
        outcome: 'NOT_FOUND',
      };
    }
    if (transaction.isTerminal()) {
      return {
        transactionId: transaction.id,
        status: transaction.status,
        outcome: 'ALREADY_FINAL',
      };
    }
    if (!wallet) {
      await persistRejection({
        uow,
        transaction,
        failureCode: FailureCode.WalletNotFound,
        resultingBalance: null,
        now,
        ids: this.ids,
        tracer: this.tracer,
        correlationId: cmd.correlationId,
        causationId: cmd.causationId,
      });
      return {
        transactionId: transaction.id,
        status: WagerTransactionStatus.Rejected,
        outcome: 'REJECTED',
      };
    }

    const reference = await this.resolveReference(uow, transaction);
    const reversalAlreadyApplied =
      reference && transaction.requiresReference()
        ? await uow.transactions.existsProcessedReversal(
            transaction.providerId,
            transaction.referenceExternalTransactionId as string,
            transaction.kind,
            reference.kind,
          )
        : false;

    const decision = await executeSettlement({
      uow,
      wallet,
      transaction,
      reference,
      reversalAlreadyApplied,
      now,
      ids: this.ids,
      tracer: this.tracer,
      correlationId: cmd.correlationId,
      causationId: cmd.causationId,
    });

    if (decision.outcome === 'PENDING_REFERENCE') {
      this.metrics.recordPendingRetry();
    }
    this.logger.info(
      {
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
        outcome: decision.outcome,
        attempts: transaction.attempts,
      },
      'settle de referência pendente concluído',
    );

    return {
      transactionId: transaction.id,
      status: transaction.status,
      outcome: decision.outcome,
    };
  }

  private async resolveReference(
    uow: UnitOfWork,
    transaction: WagerTransaction,
  ): Promise<WagerTransaction | null> {
    if (!transaction.referenceExternalTransactionId) return null;
    return uow.transactions.findByProviderExternalId(
      transaction.providerId,
      transaction.referenceExternalTransactionId,
    );
  }
}
