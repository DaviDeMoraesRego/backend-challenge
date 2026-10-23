import { Journal } from '../../domain/ledger/journal';
import { CounterpartyLedgerEntry } from '../../domain/ledger/counterparty-ledger-entry';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { OutboxMessage } from '../../domain/outbox/outbox-message';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed';
import { WagerTransactionPendingReference } from '../../domain/events/wager-transaction-pending-reference';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import {
  WagerSettlementService,
  type JournalPlan,
  type SettlementDecision,
} from '../../domain/services/wager-settlement.service';
import type { WagerTransaction } from '../../domain/transaction/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { IdGenerator, Tracer } from '../ports/misc-ports';
import type { UnitOfWork } from '../ports/unit-of-work';
import { persistRejection } from './rejection';

export interface ExecuteSettlementInput {
  readonly uow: UnitOfWork;
  readonly wallet: Wallet;
  readonly transaction: WagerTransaction;
  readonly reference: WagerTransaction | null;
  readonly reversalAlreadyApplied: boolean;
  readonly now: Date;
  readonly ids: IdGenerator;
  readonly tracer: Tracer;
  readonly correlationId: string;
  readonly causationId?: string;
  /** `true` somente no caminho interno de abertura de wallet. */
  readonly internal?: boolean;
  /** serviço de domínio injetável (default: instância compartilhada stateless). */
  readonly settlement?: WagerSettlementService;
}

type ProcessedDecision = Extract<SettlementDecision, { outcome: 'PROCESSED' }>;

interface SettlementContext {
  readonly uow: UnitOfWork;
  readonly wallet: Wallet;
  readonly transaction: WagerTransaction;
  readonly reference: WagerTransaction | null;
  readonly now: Date;
  readonly ids: IdGenerator;
  readonly tracer: Tracer;
  readonly correlationId: string;
  readonly causationId?: string;
}

const DEFAULT_SETTLEMENT_SERVICE = new WagerSettlementService();

/**
 * Núcleo compartilhado de settlement (ADR-03 passos 7–10): aplica a decisão de
 * domínio, persiste saldo + journal + 2 pernas + snapshot e enfileira eventos na
 * **mesma transação SQL**. Usado por submit (HTTP/SQS) e pelo worker de pendentes.
 */
export async function executeSettlement(
  input: ExecuteSettlementInput,
): Promise<SettlementDecision> {
  const { wallet, transaction, reference, reversalAlreadyApplied, now } = input;
  const settlement = input.settlement ?? DEFAULT_SETTLEMENT_SERVICE;

  const decision = settlement.settle({
    wallet,
    transaction,
    reference,
    reversalAlreadyApplied,
    now,
    internal: input.internal,
  });

  const context: SettlementContext = {
    uow: input.uow,
    wallet,
    transaction,
    reference,
    now,
    ids: input.ids,
    tracer: input.tracer,
    correlationId: input.correlationId,
    causationId: input.causationId,
  };

  switch (decision.outcome) {
    case 'PROCESSED':
      return decision.journal
        ? applyProcessedWithJournal(context, decision, decision.journal)
        : applyProcessedWithoutJournal(context, decision);
    case 'REJECTED':
      await persistRejection({
        uow: context.uow,
        transaction: context.transaction,
        failureCode: decision.failureCode,
        resultingBalance: context.wallet.balance,
        now: context.now,
        ids: context.ids,
        tracer: context.tracer,
        correlationId: context.correlationId,
        causationId: context.causationId,
      });
      return decision;
    case 'PENDING_REFERENCE':
      await applyPendingReference(context);
      return decision;
  }
}

/** Fluxo com movimentação de saldo: saldo + journal + 2 pernas + 2 eventos. */
async function applyProcessedWithJournal(
  context: SettlementContext,
  decision: ProcessedDecision,
  plan: JournalPlan,
): Promise<SettlementDecision> {
  const traceContext = context.tracer.injectTraceContext();
  await context.uow.wallets.applyBalance(context.wallet);

  const journal = Journal.create({
    id: context.ids.next(),
    transactionId: context.transaction.id,
    walletLeg: plan.walletLeg,
    counterpartyLeg: plan.counterpartyLeg,
    createdAt: context.now,
  });
  const walletEntry = WalletLedgerEntry.create({
    id: context.ids.next(),
    journalId: journal.id,
    walletId: context.wallet.id,
    transactionId: context.transaction.id,
    direction: plan.walletLeg.direction,
    money: plan.walletLeg.amount,
    balanceBefore: plan.walletLeg.balanceBefore,
    balanceAfter: plan.walletLeg.balanceAfter,
    walletVersion: plan.walletLeg.walletVersion,
    createdAt: context.now,
  });
  const counterpartyEntry = CounterpartyLedgerEntry.create({
    id: context.ids.next(),
    journalId: journal.id,
    transactionId: context.transaction.id,
    account: plan.counterpartyLeg.account,
    direction: plan.counterpartyLeg.direction,
    money: plan.counterpartyLeg.amount,
    createdAt: context.now,
  });
  const counterpartyAccountId = await context.uow.accounts.findOrCreateId(
    plan.counterpartyLeg.account,
    context.ids.next(),
  );

  await context.uow.ledger.insertJournalWithLegs(
    journal,
    walletEntry,
    counterpartyEntry,
    counterpartyAccountId,
  );

  context.transaction.markProcessed(
    context.reference?.id,
    context.now,
    decision.resultingBalance,
  );
  await context.uow.transactions.finalize(context.transaction);
  await enqueue(context, traceContext, () =>
    WagerTransactionProcessed.from(context.transaction, {
      eventId: context.ids.next(),
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: context.now,
      walletVersion: decision.walletVersion,
    }),
  );
  await enqueue(context, traceContext, () =>
    WalletBalanceChanged.from(context.wallet, walletEntry, {
      eventId: context.ids.next(),
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: context.now,
    }),
  );
  return decision;
}

/** LOSS: registra o resultado sem mover saldo e sem lançamentos contábeis. */
async function applyProcessedWithoutJournal(
  context: SettlementContext,
  decision: ProcessedDecision,
): Promise<SettlementDecision> {
  const traceContext = context.tracer.injectTraceContext();
  context.transaction.markProcessed(
    context.reference?.id,
    context.now,
    decision.resultingBalance,
  );
  await context.uow.transactions.finalize(context.transaction);
  await enqueue(context, traceContext, () =>
    WagerTransactionProcessed.from(context.transaction, {
      eventId: context.ids.next(),
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: context.now,
      walletVersion: decision.walletVersion,
    }),
  );
  return decision;
}

async function applyPendingReference(context: SettlementContext): Promise<void> {
  const traceContext = context.tracer.injectTraceContext();
  context.transaction.markPendingReference(
    context.now,
    nextAttemptAt(context.now, context.transaction.attempts),
  );
  await context.uow.transactions.finalize(context.transaction);
  await enqueue(context, traceContext, () =>
    WagerTransactionPendingReference.from(context.transaction, {
      eventId: context.ids.next(),
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: context.now,
    }),
  );
}

async function enqueue(
  context: SettlementContext,
  traceContext: ReturnType<Tracer['injectTraceContext']>,
  eventFactory: () => Parameters<typeof OutboxMessage.enqueue>[0],
): Promise<void> {
  await context.uow.outbox.enqueue(
    OutboxMessage.enqueue(eventFactory(), {
      id: context.ids.next(),
      now: context.now,
      traceContext,
    }),
  );
}

/** backoff exponencial do worker de referências: min(2^n · 5s, 30min) + jitter(0–2s). */
export function nextAttemptAt(
  now: Date,
  attempts: number,
  jitterMs: (ceiling: number) => number = (ceiling) =>
    Math.floor(Math.random() * (ceiling + 1)),
): Date {
  const base = Math.min(2 ** Math.min(attempts, 9) * 5_000, 1_800_000);
  return new Date(now.getTime() + base + jitterMs(2_000));
}
