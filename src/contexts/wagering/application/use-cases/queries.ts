import { LedgerDirection } from '../../domain/ledger/ledger-direction';
import type { MoneyProps } from '../../domain/money/money';
import type { FailureCode } from '../../domain/transaction/failure-code';
import type { WagerTransactionKind } from '../../domain/transaction/wager-transaction-kind';
import type { WagerTransactionStatus } from '../../domain/transaction/wager-transaction-status';
import { decodeCursor, encodeCursor } from '../../../../shared/cursor';
import type { TransactionRunner } from '../ports/unit-of-work';

export interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: MoneyProps;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LedgerEntryView {
  readonly id: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly createdAt: Date;
}

export interface LedgerPage {
  readonly entries: LedgerEntryView[];
  readonly nextCursor: string | null;
}

export interface TransactionView {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string | null;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId: string | null;
  readonly status: WagerTransactionStatus;
  readonly failureCode: FailureCode | null;
  readonly processedAt: Date | null;
  readonly createdAt: Date;
}

export class GetWallet {
  constructor(private readonly runner: TransactionRunner) {}

  /** `providerId` restringe a leitura ao dono da wallet (null = acesso de backoffice). */
  async execute(
    walletId: string,
    providerId: string | null = null,
  ): Promise<WalletView | null> {
    return this.runner.run(async (uow) => {
      const wallet = await uow.wallets.findById(walletId);
      if (!wallet) return null;
      if (providerId !== null && wallet.providerId !== providerId) return null;
      return {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      };
    });
  }
}

/** Paginação por cursor opaco e estável `(wallet_version, id)` (plans/05 §1.3). */
export class ListWalletLedger {
  constructor(private readonly runner: TransactionRunner) {}

  async execute(
    walletId: string,
    query: { cursor?: string; limit: number },
    providerId: string | null = null,
  ): Promise<LedgerPage | null> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    return this.runner.run(async (uow) => {
      const wallet = await uow.wallets.findById(walletId);
      if (!wallet) return null;
      if (providerId !== null && wallet.providerId !== providerId) return null;
      const entries = await uow.ledger.pageByWallet(walletId, cursor, query.limit);
      const last = entries[entries.length - 1];
      return {
        entries: entries.map((entry) => ({
          id: entry.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          createdAt: entry.createdAt,
        })),
        nextCursor:
          entries.length === query.limit && last
            ? encodeCursor({
                walletVersion: last.walletVersion,
                entryId: last.id,
              })
            : null,
      };
    });
  }
}

export class GetTransaction {
  constructor(private readonly runner: TransactionRunner) {}

  async execute(
    transactionId: string,
    providerId: string | null = null,
  ): Promise<TransactionView | null> {
    return this.runner.run(async (uow) => {
      const tx = await uow.transactions.findById(transactionId);
      if (!tx) return null;
      // tenancy: provedor só enxerga as próprias transações (backoffice vê tudo)
      if (providerId !== null && tx.providerId !== providerId) return null;
      return toTransactionView(tx);
    });
  }
}

export class GetTransactionByExternalId {
  constructor(private readonly runner: TransactionRunner) {}

  async execute(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionView | null> {
    return this.runner.run(async (uow) => {
      const tx = await uow.transactions.findByProviderExternalId(
        providerId,
        externalTransactionId,
      );
      return tx ? toTransactionView(tx) : null;
    });
  }
}

function toTransactionView(tx: {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string | null;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: { toJSON(): MoneyProps };
  referenceExternalTransactionId?: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  processedAt?: Date;
  createdAt: Date;
}): TransactionView {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    processedAt: tx.processedAt ?? null,
    createdAt: tx.createdAt,
  };
}
