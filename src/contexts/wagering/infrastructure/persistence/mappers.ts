import { InboxMessage } from '../../domain/inbox/inbox-message';
import { LedgerDirection } from '../../domain/ledger/ledger-direction';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { Money } from '../../domain/money/money';
import { OutboxMessage } from '../../domain/outbox/outbox-message';
import { FailureCode, isFailureCode } from '../../domain/transaction/failure-code';
import { WagerTransaction } from '../../domain/transaction/wager-transaction';
import {
  isKnownKind,
  WagerTransactionKind,
} from '../../domain/transaction/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/transaction/wager-transaction-status';
import { Wallet } from '../../domain/wallet/wallet';
import type {
  InboxRow,
  LedgerAggregateRow,
  LedgerEntryRow,
  OutboxRow,
  WagerTransactionRow,
  WalletRow,
} from './records';

const KNOWN_STATUSES = new Set(Object.values(WagerTransactionStatus) as string[]);
const KNOWN_DIRECTIONS = new Set(Object.values(LedgerDirection) as string[]);

const isKnownStatus = (value: string): value is WagerTransactionStatus =>
  KNOWN_STATUSES.has(value);

/**
 * O driver devolve `timestamptz` como string (MikroORM ajusta os parsers do pg);
 * a conversão explícita mantém o domínio trabalhando sempre com `Date`.
 */
export function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function asOptionalDate(
  value: Date | string | null | undefined,
): Date | undefined {
  if (value === null || value === undefined) return undefined;
  return asDate(value);
}

export function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    providerId: row.provider_id ?? null,
    currency: row.currency,
    balance: Money.of(row.balance, row.currency),
    version: Number(row.version),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  });
}

export function toWagerTransaction(row: WagerTransactionRow): WagerTransaction {
  if (!isKnownKind(row.kind)) {
    throw new Error(`kind desconhecido no banco: ${row.kind}`);
  }
  if (!isKnownStatus(row.status)) {
    throw new Error(`status desconhecido no banco: ${row.status}`);
  }
  let failureCode: FailureCode | undefined;
  if (row.failure_code) {
    if (!isFailureCode(row.failure_code)) {
      throw new Error(`failure_code desconhecido no banco: ${row.failure_code}`);
    }
    failureCode = row.failure_code;
  }
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind,
    money: Money.of(row.amount, row.currency),
    referenceExternalTransactionId:
      row.reference_external_transaction_id ?? undefined,
    createdAt: asDate(row.created_at),
    status: row.status,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    failureCode,
    resultingBalance: row.resulting_balance_amount
      ? Money.of(row.resulting_balance_amount, row.currency)
      : undefined,
    processedAt: asOptionalDate(row.processed_at),
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: asOptionalDate(row.next_attempt_at),
  });
}

export function toWalletLedgerEntry(row: LedgerEntryRow): WalletLedgerEntry {
  if (!row.wallet_id || row.balance_before === null || row.balance_after === null) {
    throw new Error(`lançamento ${row.id} não é perna de wallet`);
  }
  if (!KNOWN_DIRECTIONS.has(row.direction)) {
    throw new Error(`direction desconhecida: ${row.direction}`);
  }
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    journalId: row.journal_id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: row.direction as LedgerDirection,
    money: Money.of(row.amount, row.currency),
    balanceBefore: Money.of(row.balance_before, row.currency),
    balanceAfter: Money.of(row.balance_after, row.currency),
    walletVersion: Number(row.wallet_version ?? 0),
    createdAt: asDate(row.created_at),
  });
}

export function toOutboxMessage(row: OutboxRow): OutboxMessage {
  const traceparent = row.trace_context?.traceparent;
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: asDate(row.occurred_at),
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: asDate(row.next_attempt_at),
    publishedAt: asOptionalDate(row.published_at),
    traceContext: traceparent
      ? { traceparent, tracestate: row.trace_context?.tracestate }
      : undefined,
  });
}

export function toInboxMessage(row: InboxRow): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: row.consumer_name,
    messageId: row.message_id,
    payloadHash: row.payload_hash,
    receivedAt: asDate(row.received_at),
    processedAt: asOptionalDate(row.processed_at),
  });
}

export function toLedgerAggregate(row: LedgerAggregateRow | undefined): {
  sum: string;
  entries: number;
  currency: string | null;
  lastBalanceAfter: string | null;
  lastWalletVersion: number | null;
} {
  if (!row) {
    return {
      sum: '0.00',
      entries: 0,
      currency: null,
      lastBalanceAfter: null,
      lastWalletVersion: null,
    };
  }
  return {
    sum: row.sum,
    entries: Number(row.entries),
    currency: row.currency,
    lastBalanceAfter: row.last_balance_after,
    lastWalletVersion: row.last_wallet_version
      ? Number(row.last_wallet_version)
      : null,
  };
}

export const OPENING_KIND = WagerTransactionKind.Opening;
