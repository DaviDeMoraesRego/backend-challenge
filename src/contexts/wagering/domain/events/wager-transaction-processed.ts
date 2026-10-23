import type { MoneyProps } from '../money/money';
import type { WagerTransaction } from '../transaction/wager-transaction';
import type { WagerTransactionKind } from '../transaction/wager-transaction-kind';
import { EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionProcessedData {
  readonly transactionId: string;
  readonly walletId: string | null;
  readonly providerId: string;
  readonly playerId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps | null;
  readonly referenceExternalTransactionId: string | null;
  readonly walletVersion: number | null;
  readonly resultingBalance: MoneyProps | null;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext & { walletVersion?: number }): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: ctx.eventId,
      aggregateId: tx.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        playerId: tx.playerId,
        kind: tx.kind,
        money: tx.affectsBalance() ? tx.money.toJSON() : null,
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
        walletVersion: ctx.walletVersion ?? null,
        resultingBalance: tx.resultingBalance ? tx.resultingBalance.toJSON() : null,
      },
    });
  }
}
