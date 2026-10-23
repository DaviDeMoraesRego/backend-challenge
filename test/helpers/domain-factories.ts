import { Money } from '../../src/contexts/wagering/domain/money/money';
import { FailureCode } from '../../src/contexts/wagering/domain/transaction/failure-code';
import { WagerTransaction } from '../../src/contexts/wagering/domain/transaction/wager-transaction';
import {
  WagerTransactionKind,
} from '../../src/contexts/wagering/domain/transaction/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/contexts/wagering/domain/transaction/wager-transaction-status';
import { Wallet } from '../../src/contexts/wagering/domain/wallet/wallet';

export const NOW = new Date('2026-07-29T15:00:00.000Z');
export const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
export const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
export const OTHER_PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2';
export const PROVIDER_ID = 'provider-a';

export function makeWallet(options: {
  balance?: string;
  currency?: string;
  version?: number;
  id?: string;
  playerId?: string;
} = {}): Wallet {
  const currency = options.currency ?? 'BRL';
  return Wallet.rehydrate({
    id: options.id ?? WALLET_ID,
    playerId: options.playerId ?? PLAYER_ID,
    providerId: null,
    currency,
    balance: Money.of(options.balance ?? '100.00', currency),
    version: options.version ?? 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

let sequence = 0;

export interface TransactionOverrides {
  id?: string;
  kind?: WagerTransactionKind;
  amount?: string;
  currency?: string;
  walletId?: string | null;
  playerId?: string;
  roundId?: string;
  referenceExternalTransactionId?: string;
  status?: WagerTransactionStatus;
}

export function makeTransaction(overrides: TransactionOverrides = {}): WagerTransaction {
  sequence += 1;
  const currency = overrides.currency ?? 'BRL';
  return WagerTransaction.rehydrate({
    id: overrides.id ?? `tx-${sequence}`,
    providerId: PROVIDER_ID,
    externalTransactionId: `ext-${sequence}`,
    idempotencyKey: `key-${sequence}`,
    payloadHash: `hash-${sequence}`,
    walletId: overrides.walletId === undefined ? WALLET_ID : overrides.walletId,
    playerId: overrides.playerId ?? PLAYER_ID,
    roundId: overrides.roundId ?? 'round-987',
    gameId: 'fortune-chimp',
    kind: overrides.kind ?? WagerTransactionKind.Bet,
    money: Money.of(overrides.amount ?? '25.00', currency),
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
    createdAt: NOW,
    status: overrides.status ?? WagerTransactionStatus.Pending,
    attempts: 0,
  });
}

export function makeProcessedReference(
  overrides: TransactionOverrides = {},
): WagerTransaction {
  const reference = makeTransaction({
    kind: WagerTransactionKind.Bet,
    ...overrides,
  });
  reference.markProcessed(
    undefined,
    NOW,
    Money.of('0.00', overrides.currency ?? 'BRL'),
  );
  return reference;
}

export function makeRejectedReference(
  overrides: TransactionOverrides = {},
): WagerTransaction {
  const reference = makeTransaction({ kind: WagerTransactionKind.Bet, ...overrides });
  reference.reject(
    FailureCode.InsufficientFunds,
    NOW,
    Money.of('0.00', overrides.currency ?? 'BRL'),
  );
  return reference;
}
