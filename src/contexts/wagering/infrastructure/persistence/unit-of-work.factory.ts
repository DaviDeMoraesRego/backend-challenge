import type { EntityManager } from '@mikro-orm/core';
import type { UnitOfWork } from '../../application/ports/unit-of-work';
import { MikroAccountRepository } from './repositories/account.repository';
import { MikroInboxRepository } from './repositories/inbox.repository';
import { MikroLedgerRepository } from './repositories/ledger.repository';
import { MikroOutboxRepository } from './repositories/outbox.repository';
import { MikroWagerTransactionRepository } from './repositories/wager-transaction.repository';
import { MikroWalletRepository } from './repositories/wallet.repository';
import { MikroDbSession } from './sql-session';

/** Um Unit of Work por execução de caso de uso (fork isolado — ADR-08). */
export function buildUnitOfWork(em: EntityManager): UnitOfWork {
  const session = new MikroDbSession(em);
  return {
    session,
    wallets: new MikroWalletRepository(session),
    transactions: new MikroWagerTransactionRepository(session),
    ledger: new MikroLedgerRepository(session),
    accounts: new MikroAccountRepository(session),
    inbox: new MikroInboxRepository(session),
    outbox: new MikroOutboxRepository(session),
  };
}
