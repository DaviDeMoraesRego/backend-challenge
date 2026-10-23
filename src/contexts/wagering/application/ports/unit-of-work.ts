import type { DbSession } from './db-session';
import type {
  AccountRepository,
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from './repositories';

export interface UnitOfWork {
  readonly session: DbSession;
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly accounts: AccountRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

export interface RunOptions {
  readonly maxRetries?: number;
}

/**
 * Fronteira transacional (ADR-08). Retry interno apenas para SQLSTATE transitório
 * (40001, 40P01, 55P03, 08xxx, 57P01) — nunca em statements individuais.
 */
export interface TransactionRunner {
  run<T>(work: (uow: UnitOfWork) => Promise<T>, options?: RunOptions): Promise<T>;
}
