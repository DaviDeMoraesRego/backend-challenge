import { CounterpartyLegDraft } from '../ledger/counterparty-leg-draft';
import { LedgerDirection, oppositeDirection } from '../ledger/ledger-direction';
import { openingEquityAccount, providerClearingAccount } from '../ledger/account-ref';
import { Money } from '../money/money';
import { FailureCode } from '../transaction/failure-code';
import { WagerTransaction } from '../transaction/wager-transaction';
import { WagerTransactionKind } from '../transaction/wager-transaction-kind';
import { WagerTransactionStatus } from '../transaction/wager-transaction-status';
import { Wallet, WalletLegDraft } from '../wallet/wallet';

export interface JournalPlan {
  readonly currency: string;
  readonly walletLeg: WalletLegDraft;
  readonly counterpartyLeg: CounterpartyLegDraft;
}

export type SettlementDecision =
  | {
      readonly outcome: 'PROCESSED';
      readonly resultingBalance: Money;
      readonly walletVersion: number;
      readonly journal: JournalPlan | null;
    }
  | { readonly outcome: 'REJECTED'; readonly failureCode: FailureCode }
  | { readonly outcome: 'PENDING_REFERENCE' };

export interface SettlementInput {
  readonly wallet: Wallet;
  readonly transaction: WagerTransaction;
  /** Referência já resolvida por (providerId, referenceExternalTransactionId). */
  readonly reference?: WagerTransaction | null;
  readonly reversalAlreadyApplied: boolean;
  readonly now: Date;
  /** `true` apenas para o caminho interno de abertura de wallet (OPENING). */
  readonly internal?: boolean;
}

const REVERSIBLE_BY_ROLLBACK: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
];

/**
 * Domain service puro (ADR-02): implementa a tabela kind × referência
 * (plans/02 §5.3) e constrói as duas pernas da partida dobrada.
 * Não conhece banco, fila nem HTTP — testável sem IO (UT-21…UT-44).
 */
export class WagerSettlementService {
  settle(input: SettlementInput): SettlementDecision {
    const { wallet, transaction: tx, reference, reversalAlreadyApplied, now } = input;

    if (tx.kind === WagerTransactionKind.Opening && !input.internal) {
      return rejected(FailureCode.OpeningNotAllowed);
    }
    if (tx.money.currency !== wallet.currency) {
      return rejected(FailureCode.CurrencyMismatch);
    }
    if (tx.playerId !== wallet.playerId) {
      return rejected(FailureCode.PlayerMismatch);
    }
    if (tx.requiresReference() && !tx.referenceExternalTransactionId) {
      return rejected(FailureCode.ReferenceRequired);
    }

    let resolvedReference: WagerTransaction | null = null;
    if (tx.referenceExternalTransactionId) {
      if (!reference) return pendingReference();
      // Referência ainda não aplicada: o worker reavalia depois (README §7.1).
      if (
        reference.status === WagerTransactionStatus.Pending ||
        reference.status === WagerTransactionStatus.PendingReference
      ) {
        return pendingReference();
      }
      if (
        reference.status === WagerTransactionStatus.Rejected ||
        reference.status === WagerTransactionStatus.Failed
      ) {
        return rejected(FailureCode.ReferenceNotReversible);
      }
      if (
        reference.walletId !== tx.walletId ||
        reference.playerId !== tx.playerId ||
        reference.money.currency !== tx.money.currency ||
        reference.roundId !== tx.roundId
      ) {
        return rejected(FailureCode.ReferenceScopeMismatch);
      }
      if (
        tx.kind === WagerTransactionKind.Refund &&
        reference.kind !== WagerTransactionKind.Bet
      ) {
        return rejected(FailureCode.InvalidReferenceKind);
      }
      if (
        tx.kind === WagerTransactionKind.Rollback &&
        !REVERSIBLE_BY_ROLLBACK.includes(reference.kind)
      ) {
        return rejected(FailureCode.InvalidReferenceKind);
      }
      const isReversal =
        tx.kind === WagerTransactionKind.Refund ||
        tx.kind === WagerTransactionKind.Rollback;
      if (isReversal && !reference.money.equals(tx.money)) {
        return rejected(FailureCode.AmountMismatch);
      }
      if (isReversal && reversalAlreadyApplied) {
        return rejected(FailureCode.ReversalAlreadyApplied);
      }
      resolvedReference = reference;
    }

    switch (tx.kind) {
      case WagerTransactionKind.Opening: {
        const leg = wallet.credit(tx.money, now);
        return processed(wallet, tx, leg);
      }
      case WagerTransactionKind.Bet: {
        if (!wallet.canDebit(tx.money)) {
          return rejected(FailureCode.InsufficientFunds);
        }
        const leg = wallet.debit(tx.money, now);
        return processed(wallet, tx, leg);
      }
      case WagerTransactionKind.Win: {
        const leg = wallet.credit(tx.money, now);
        return processed(wallet, tx, leg);
      }
      case WagerTransactionKind.Loss:
        return {
          outcome: 'PROCESSED',
          resultingBalance: wallet.balance,
          walletVersion: wallet.version,
          journal: null,
        };
      case WagerTransactionKind.Refund: {
        const leg = wallet.credit(tx.money, now);
        return processed(wallet, tx, leg);
      }
      case WagerTransactionKind.Rollback: {
        const direction = tx.ledgerDirectionFor(resolvedReference);
        if (direction === LedgerDirection.Credit) {
          const leg = wallet.credit(tx.money, now);
          return processed(wallet, tx, leg);
        }
        if (direction === LedgerDirection.Debit) {
          if (!wallet.canDebit(tx.money)) {
            return rejected(FailureCode.ReversalInsufficientFunds);
          }
          const leg = wallet.debit(tx.money, now);
          return processed(wallet, tx, leg);
        }
        return rejected(FailureCode.InvalidReferenceKind);
      }
      default:
        return rejected(FailureCode.OpeningNotAllowed);
    }
  }
}

const rejected = (failureCode: FailureCode): SettlementDecision => ({
  outcome: 'REJECTED',
  failureCode,
});

const pendingReference = (): SettlementDecision => ({ outcome: 'PENDING_REFERENCE' });

const processed = (
  wallet: Wallet,
  tx: WagerTransaction,
  leg: WalletLegDraft,
): SettlementDecision => ({
  outcome: 'PROCESSED',
  resultingBalance: wallet.balance,
  walletVersion: wallet.version,
  journal: {
    currency: wallet.currency,
    walletLeg: leg,
    counterpartyLeg: {
      account:
        tx.kind === WagerTransactionKind.Opening
          ? openingEquityAccount(wallet.currency)
          : providerClearingAccount(tx.providerId, wallet.currency),
      direction: oppositeDirection(leg.direction),
      amount: leg.amount,
    },
  },
});
