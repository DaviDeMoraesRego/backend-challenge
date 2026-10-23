import type { AccountRef } from '../../domain/ledger/account-ref';
import type { CounterpartyLedgerEntry } from '../../domain/ledger/counterparty-ledger-entry';
import type { Journal } from '../../domain/ledger/journal';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { InboxMessage } from '../../domain/inbox/inbox-message';
import type { OutboxMessage } from '../../domain/outbox/outbox-message';
import type { FailureCode } from '../../domain/transaction/failure-code';
import type { WagerTransaction } from '../../domain/transaction/wager-transaction';
import type { WagerTransactionKind } from '../../domain/transaction/wager-transaction-kind';
import type { Wallet } from '../../domain/wallet/wallet';

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;
  /** SELECT … FOR UPDATE — único lock de linha do caminho quente. */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  findById(id: string): Promise<Wallet | null>;
  exists(id: string): Promise<boolean>;
  /**
   * Vincula a wallet a um provedor **somente** se ainda não houver dono.
   * Retorna `false` quando já existe dono diferente (conflito de tenancy).
   */
  claimProvider(id: string, providerId: string): Promise<boolean>;
  /** UPDATE com guarda otimista (version) — falha se a versão divergir. */
  applyBalance(wallet: Wallet): Promise<void>;
  pageAfter(cursorId: string | null, limit: number): Promise<Wallet[]>;
}

export interface AccountRepository {
  findId(ref: AccountRef): Promise<string | null>;
  /** INSERT … ON CONFLICT DO NOTHING — a linha nunca é atualizada (sem hot row). */
  findOrCreateId(ref: AccountRef, id: string): Promise<string>;
}

export interface InsertOutcome {
  readonly outcome: 'inserted' | 'conflict';
}

export interface PendingReferenceClaim {
  readonly id: string;
  readonly attempts: number;
  readonly createdAt: Date;
}

export interface WagerTransactionRepository {
  insertPending(tx: WagerTransaction): Promise<InsertOutcome>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdForUpdate(id: string): Promise<WagerTransaction | null>;
  /**
   * `referenceKind` permite tratar REFUND e ROLLBACK como estornos mutuamente
   * exclusivos quando a referência é uma BET (evita crédito duplicado).
   */
  existsProcessedReversal(
    providerId: string,
    referenceExternalTransactionId: string,
    kind: WagerTransactionKind,
    referenceKind?: WagerTransactionKind,
  ): Promise<boolean>;
  finalize(tx: WagerTransaction): Promise<void>;
  claimPendingReference(
    limit: number,
    leaseMs: number,
  ): Promise<PendingReferenceClaim[]>;
  findDependentIds(
    providerId: string,
    referenceExternalTransactionId: string,
  ): Promise<string[]>;
  scheduleNextAttempt(id: string, attempts: number, nextAt: Date): Promise<void>;
  countPendingReference(): Promise<number>;
}

export interface LedgerAggregate {
  readonly sum: string;
  readonly entries: number;
  readonly currency: string | null;
  readonly lastBalanceAfter: string | null;
  readonly lastWalletVersion: number | null;
}

export interface LedgerRepository {
  insertJournalWithLegs(
    journal: Journal,
    walletEntry: WalletLedgerEntry,
    counterpartyEntry: CounterpartyLedgerEntry,
    counterpartyAccountId: string,
  ): Promise<void>;
  sumByWallet(walletId: string): Promise<LedgerAggregate>;
  pageByWallet(
    walletId: string,
    cursor: { walletVersion: number; entryId: string } | null,
    limit: number,
  ): Promise<WalletLedgerEntry[]>;
  /** quantidade de quebras na cadeia balance_before/after (LAG). */
  chainCheck(walletId: string): Promise<number>;
  aggregateByWallets(walletIds: readonly string[]): Promise<Map<string, LedgerAggregate>>;
  journalImbalanceByCurrency(): Promise<Array<{ currency: string; net: string }>>;
}

export interface InboxClaimResult {
  readonly inserted: boolean;
  readonly alreadyProcessed: boolean;
}

export interface InboxRepository {
  claim(message: InboxMessage): Promise<InboxClaimResult>;
  markProcessed(consumerName: string, messageId: string, at: Date): Promise<void>;
}

export interface OutboxLag {
  readonly backlog: number;
  readonly oldestCreatedAt: Date | null;
}

export interface OutboxRepository {
  enqueue(message: OutboxMessage): Promise<void>;
  claimDue(limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  markPublished(id: string, at: Date): Promise<void>;
  /** Marca um lote em um único UPDATE (evita N transações por ciclo). */
  markPublishedMany(ids: readonly string[], at: Date): Promise<void>;
  scheduleRetry(id: string, attempts: number, nextAt: Date): Promise<void>;
  findById(id: string): Promise<OutboxMessage | null>;
  lag(): Promise<OutboxLag>;
}

export interface FailureSnapshotRow {
  readonly failureCode: FailureCode;
  readonly resultingBalance: string | null;
  readonly currency: string | null;
}
