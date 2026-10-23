import { LedgerArithmeticError } from '../errors/domain-errors';
import { Money } from '../money/money';
import { LedgerDirection } from './ledger-direction';

export interface CreateLedgerEntryProps {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {
  readonly journalId: string;
  readonly walletVersion: number;
}

/**
 * Lançamento imutável da perna de wallet (README §6.4).
 * Sem campos mutáveis e sem métodos de transição: a imutabilidade é estrutural.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly journalId: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {}

  static create(props: LedgerEntryState): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      props.id,
      props.journalId,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.walletVersion,
      props.createdAt,
    );
    if (!entry.isBalanced()) {
      throw new LedgerArithmeticError(
        `${props.direction} ${props.money.toString()} ${props.money.currency} de ${props.balanceBefore.toString()} para ${props.balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.journalId,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter (validado na factory). */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}
