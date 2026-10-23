import type { WagerTransaction } from '../transaction/wager-transaction';
import type { WagerTransactionKind } from '../transaction/wager-transaction-kind';
import { EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionPendingReferenceData {
  readonly transactionId: string;
  readonly walletId: string | null;
  readonly providerId: string;
  readonly kind: WagerTransactionKind;
  readonly referenceExternalTransactionId: string | null;
  readonly attempts: number;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
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
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
        attempts: tx.attempts,
      },
    });
  }
}
