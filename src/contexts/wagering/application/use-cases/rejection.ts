import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected';
import { OutboxMessage } from '../../domain/outbox/outbox-message';
import type { FailureCode } from '../../domain/transaction/failure-code';
import type { WagerTransaction } from '../../domain/transaction/wager-transaction';
import type { Money } from '../../domain/money/money';
import type { IdGenerator, Tracer } from '../ports/misc-ports';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface PersistRejectionInput {
  readonly uow: UnitOfWork;
  readonly transaction: WagerTransaction;
  readonly failureCode: FailureCode;
  readonly resultingBalance: Money | null;
  readonly now: Date;
  readonly ids: IdGenerator;
  readonly tracer: Tracer;
  readonly correlationId: string;
  readonly causationId?: string;
}

/**
 * Rejeição de negócio **commita** (plans/08 §4 premissa 2): o registro REJECTED,
 * o snapshot de saldo e o evento são persistidos na mesma transação.
 */
export async function persistRejection(
  input: PersistRejectionInput,
): Promise<void> {
  const {
    uow,
    transaction,
    failureCode,
    resultingBalance,
    now,
    ids,
    tracer,
    correlationId,
    causationId,
  } = input;

  transaction.reject(failureCode, now, resultingBalance ?? undefined);
  await uow.transactions.finalize(transaction);
  const event = WagerTransactionRejected.from(transaction, {
    eventId: ids.next(),
    correlationId,
    causationId,
    occurredAt: now,
  });
  await uow.outbox.enqueue(
    OutboxMessage.enqueue(event, {
      id: ids.next(),
      now,
      traceContext: tracer.injectTraceContext(),
    }),
  );
}
