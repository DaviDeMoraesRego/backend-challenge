import type { MoneyProps } from '../money/money';
import type { FailureCode } from '../transaction/failure-code';
import type { WagerTransaction } from '../transaction/wager-transaction';
import type { WagerTransactionKind } from '../transaction/wager-transaction-kind';
import { EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionRejectedData {
  readonly transactionId: string;
  readonly walletId: string | null;
  readonly providerId: string;
  readonly kind: WagerTransactionKind;
  readonly failureCode: FailureCode;
  readonly money: MoneyProps | null;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode) {
      throw new Error(`transação ${tx.id} sem failureCode não pode gerar WagerTransactionRejected`);
    }
    return new WagerTransactionRejected({
      eventId: ctx.eventId,
      aggregateId: tx.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        kind: tx.kind,
        failureCode: tx.failureCode,
        money: tx.affectsBalance() ? tx.money.toJSON() : null,
      },
    });
  }
}
