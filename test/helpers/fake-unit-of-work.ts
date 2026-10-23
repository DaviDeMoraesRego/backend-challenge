import type { DbSession } from '../../src/contexts/wagering/application/ports/db-session';
import type {
  AccountRepository,
  InboxClaimResult,
  InboxRepository,
  LedgerAggregate,
  LedgerRepository,
  OutboxLag,
  OutboxRepository,
  PendingReferenceClaim,
  WagerTransactionRepository,
  WalletRepository,
} from '../../src/contexts/wagering/application/ports/repositories';
import type {
  TransactionRunner,
  UnitOfWork,
} from '../../src/contexts/wagering/application/ports/unit-of-work';
import type { AccountRef } from '../../src/contexts/wagering/domain/ledger/account-ref';
import type { CounterpartyLedgerEntry } from '../../src/contexts/wagering/domain/ledger/counterparty-ledger-entry';
import type { Journal } from '../../src/contexts/wagering/domain/ledger/journal';
import type { WalletLedgerEntry } from '../../src/contexts/wagering/domain/ledger/wallet-ledger-entry';
import type { InboxMessage } from '../../src/contexts/wagering/domain/inbox/inbox-message';
import type { OutboxMessage } from '../../src/contexts/wagering/domain/outbox/outbox-message';
import type { WagerTransaction } from '../../src/contexts/wagering/domain/transaction/wager-transaction';
import { WagerTransactionKind } from '../../src/contexts/wagering/domain/transaction/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/contexts/wagering/domain/transaction/wager-transaction-status';
import { LedgerDirection } from '../../src/contexts/wagering/domain/ledger/ledger-direction';
import { Money } from '../../src/contexts/wagering/domain/money/money';
import { Wallet } from '../../src/contexts/wagering/domain/wallet/wallet';

class FakeSession implements DbSession {
  async query<T>(): Promise<T[]> {
    throw new Error('fake UnitOfWork: SQL direto não é usado nos testes de use case');
  }

  async queryOne<T>(): Promise<T | null> {
    throw new Error('fake UnitOfWork: SQL direto não é usado nos testes de use case');
  }
}

class FakeWalletRepository implements WalletRepository {
  constructor(
    private readonly wallets: Map<string, Wallet>,
    private readonly now: () => Date,
  ) {}

  async insert(wallet: Wallet): Promise<void> {
    this.wallets.set(wallet.id, wallet);
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    return this.wallets.get(id) ?? null;
  }

  async findById(id: string): Promise<Wallet | null> {
    return this.wallets.get(id) ?? null;
  }

  async exists(id: string): Promise<boolean> {
    return this.wallets.has(id);
  }

  async claimProvider(id: string, providerId: string): Promise<boolean> {
    const wallet = this.wallets.get(id);
    if (!wallet || wallet.providerId !== null) return false;
    this.wallets.set(
      id,
      Wallet.rehydrate({
        id: wallet.id,
        playerId: wallet.playerId,
        providerId,
        currency: wallet.currency,
        balance: wallet.balance,
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: this.now(),
      }),
    );
    return true;
  }

  /**
   * Espelha o `UPDATE wallets SET balance, version` real: o vínculo de provedor
   * já gravado na linha é preservado (a aplicação nunca reescreve provider_id).
   */
  async applyBalance(wallet: Wallet): Promise<void> {
    const stored = this.wallets.get(wallet.id);
    this.wallets.set(
      wallet.id,
      Wallet.rehydrate({
        id: wallet.id,
        playerId: wallet.playerId,
        providerId: stored?.providerId ?? wallet.providerId,
        currency: wallet.currency,
        balance: wallet.balance,
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      }),
    );
  }

  async pageAfter(cursorId: string | null, limit: number): Promise<Wallet[]> {
    const all = [...this.wallets.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    const start = cursorId ? all.findIndex((wallet) => wallet.id > cursorId) : 0;
    return all.slice(Math.max(0, start), Math.max(0, start) + limit);
  }
}

class FakeWagerTransactionRepository implements WagerTransactionRepository {
  private readonly byId = new Map<string, WagerTransaction>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly byProviderExternal = new Map<string, string>();

  async insertPending(tx: WagerTransaction): Promise<{ outcome: 'inserted' | 'conflict' }> {
    if (
      this.byIdempotencyKey.has(tx.idempotencyKey) ||
      this.byProviderExternal.has(`${tx.providerId}:${tx.externalTransactionId}`)
    ) {
      return { outcome: 'conflict' };
    }
    this.byId.set(tx.id, tx);
    this.byIdempotencyKey.set(tx.idempotencyKey, tx.id);
    this.byProviderExternal.set(`${tx.providerId}:${tx.externalTransactionId}`, tx.id);
    return { outcome: 'inserted' };
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const id = this.byIdempotencyKey.get(key);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const id = this.byProviderExternal.get(`${providerId}:${externalTransactionId}`);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    return this.byId.get(id) ?? null;
  }

  async findByIdForUpdate(id: string): Promise<WagerTransaction | null> {
    return this.byId.get(id) ?? null;
  }

  /** Replica o índice parcial `uq_wtx_reversal_once` + a regra BET (REFUND/ROLLBACK). */
  async existsProcessedReversal(
    providerId: string,
    referenceExternalTransactionId: string,
    kind: WagerTransactionKind,
    referenceKind?: WagerTransactionKind,
  ): Promise<boolean> {
    const kinds =
      referenceKind === WagerTransactionKind.Bet
        ? [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]
        : [kind];
    return [...this.byId.values()].some(
      (tx) =>
        tx.providerId === providerId &&
        tx.referenceExternalTransactionId === referenceExternalTransactionId &&
        kinds.includes(tx.kind) &&
        tx.status === WagerTransactionStatus.Processed,
    );
  }

  async finalize(tx: WagerTransaction): Promise<void> {
    this.byId.set(tx.id, tx);
  }

  async claimPendingReference(): Promise<PendingReferenceClaim[]> {
    return [];
  }

  async findDependentIds(
    providerId: string,
    referenceExternalTransactionId: string,
  ): Promise<string[]> {
    return [...this.byId.values()]
      .filter(
        (tx) =>
          tx.providerId === providerId &&
          tx.referenceExternalTransactionId === referenceExternalTransactionId &&
          tx.status === WagerTransactionStatus.PendingReference,
      )
      .map((tx) => tx.id);
  }

  async scheduleNextAttempt(): Promise<void> {
    return;
  }

  async countPendingReference(): Promise<number> {
    return [...this.byId.values()].filter(
      (tx) => tx.status === WagerTransactionStatus.PendingReference,
    ).length;
  }
}

class FakeLedgerRepository implements LedgerRepository {
  readonly journals: Journal[] = [];
  readonly walletEntries: WalletLedgerEntry[] = [];
  readonly counterpartyEntries: CounterpartyLedgerEntry[] = [];

  async insertJournalWithLegs(
    journal: Journal,
    walletEntry: WalletLedgerEntry,
    counterpartyEntry: CounterpartyLedgerEntry,
  ): Promise<void> {
    this.journals.push(journal);
    this.walletEntries.push(walletEntry);
    this.counterpartyEntries.push(counterpartyEntry);
  }

  async sumByWallet(walletId: string): Promise<LedgerAggregate> {
    const entries = this.walletEntries.filter((entry) => entry.walletId === walletId);
    const currency = entries[0]?.money.currency ?? 'BRL';
    let sum = Money.zero(currency);
    for (const entry of entries) {
      sum =
        entry.direction === LedgerDirection.Debit
          ? sum.subtract(entry.money)
          : sum.add(entry.money);
    }
    return {
      sum: sum.toString(),
      entries: entries.length,
      currency: entries[0]?.money.currency ?? null,
      lastBalanceAfter: null,
      lastWalletVersion: null,
    };
  }

  async pageByWallet(): Promise<WalletLedgerEntry[]> {
    return [];
  }

  async chainCheck(): Promise<number> {
    return 0;
  }

  async aggregateByWallets(): Promise<Map<string, LedgerAggregate>> {
    return new Map();
  }

  async journalImbalanceByCurrency(): Promise<Array<{ currency: string; net: string }>> {
    return [];
  }
}

class FakeAccountRepository implements AccountRepository {
  private readonly ids = new Map<string, string>();

  async findId(ref: AccountRef): Promise<string | null> {
    return this.ids.get(`${ref.code}:${ref.owner}:${ref.currency}`) ?? null;
  }

  async findOrCreateId(ref: AccountRef, id: string): Promise<string> {
    const key = `${ref.code}:${ref.owner}:${ref.currency}`;
    const existing = this.ids.get(key);
    if (existing) return existing;
    this.ids.set(key, id);
    return id;
  }
}

class FakeInboxRepository implements InboxRepository {
  private readonly rows = new Map<string, { processedAt: Date | null }>();

  async claim(message: InboxMessage): Promise<InboxClaimResult> {
    const key = `${message.consumerName}:${message.messageId}`;
    const existing = this.rows.get(key);
    if (!existing) {
      this.rows.set(key, { processedAt: null });
      return { inserted: true, alreadyProcessed: false };
    }
    return { inserted: false, alreadyProcessed: existing.processedAt !== null };
  }

  async markProcessed(consumerName: string, messageId: string, at: Date): Promise<void> {
    this.rows.set(`${consumerName}:${messageId}`, { processedAt: at });
  }
}

class FakeOutboxRepository implements OutboxRepository {
  readonly messages: OutboxMessage[] = [];

  async enqueue(message: OutboxMessage): Promise<void> {
    this.messages.push(message);
  }

  async claimDue(): Promise<OutboxMessage[]> {
    return [];
  }

  async markPublished(): Promise<void> {
    return;
  }

  async markPublishedMany(): Promise<void> {
    return;
  }

  async scheduleRetry(): Promise<void> {
    return;
  }

  async findById(): Promise<OutboxMessage | null> {
    return null;
  }

  async lag(): Promise<OutboxLag> {
    return { backlog: 0, oldestCreatedAt: null };
  }
}

export interface FakeUnitOfWork {
  readonly uow: UnitOfWork;
  readonly runner: TransactionRunner;
  readonly wallets: Map<string, Wallet>;
  readonly transactions: FakeWagerTransactionRepository;
  readonly ledger: FakeLedgerRepository;
  readonly accounts: FakeAccountRepository;
  readonly inbox: FakeInboxRepository;
  readonly outbox: FakeOutboxRepository;
}

/** Unit of Work em memória: exercita use cases sem PostgreSQL (sem I/O). */
export function createFakeUnitOfWork(now: () => Date = () => new Date()): FakeUnitOfWork {
  const wallets = new Map<string, Wallet>();
  const transactions = new FakeWagerTransactionRepository();
  const ledger = new FakeLedgerRepository();
  const accounts = new FakeAccountRepository();
  const inbox = new FakeInboxRepository();
  const outbox = new FakeOutboxRepository();

  const uow: UnitOfWork = {
    session: new FakeSession(),
    wallets: new FakeWalletRepository(wallets, now),
    transactions,
    ledger,
    accounts,
    inbox,
    outbox,
  };

  const runner: TransactionRunner = {
    run: <T>(work: (unit: UnitOfWork) => Promise<T>): Promise<T> => work(uow),
  };

  return { uow, runner, wallets, transactions, ledger, accounts, inbox, outbox };
}
