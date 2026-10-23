import {
  CurrencyMismatchError,
  InsufficientFundsError,
} from '../errors/domain-errors';
import { Currency } from '../money/currency';
import { Money } from '../money/money';
import { LedgerDirection } from '../ledger/ledger-direction';
import { WalletState } from './wallet-state';

export interface WalletLegDraft {
  readonly walletId: string;
  readonly direction: LedgerDirection;
  readonly amount: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  /** versão **após** o incremento */
  readonly walletVersion: number;
}

/**
 * Aggregate Root: protege saldo e versão (ADR-02).
 * Toda alteração de saldo retorna a perna de ledger correspondente — é impossível
 * mover dinheiro sem produzir o rascunho contábil.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly providerId: string | null,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** Abre com saldo ZERO e version 1; o crédito inicial vira transação OPENING (plans/02 §4.4). */
  static open(props: {
    id: string;
    playerId: string;
    currency: Currency | string;
    now: Date;
    providerId?: string | null;
  }): Wallet {
    const currency =
      typeof props.currency === 'string' ? props.currency : props.currency.code;
    return new Wallet(
      props.id,
      props.playerId,
      props.providerId ?? null,
      currency,
      Money.zero(currency),
      1,
      props.now,
      props.now,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições (README §6.0). */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.providerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    return !this._balance.isLessThan(money);
  }

  debit(money: Money, now: Date = new Date()): WalletLegDraft {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InsufficientFundsError(
        this._balance.toString(),
        money.toString(),
        this.currency,
      );
    }
    if (this._balance.isLessThan(money)) {
      throw new InsufficientFundsError(
        this._balance.toString(),
        money.toString(),
        this.currency,
      );
    }
    const balanceBefore = this._balance;
    this._balance = balanceBefore.subtract(money);
    this._version += 1;
    this._updatedAt = now;
    return {
      walletId: this.id,
      direction: LedgerDirection.Debit,
      amount: money,
      balanceBefore,
      balanceAfter: this._balance,
      walletVersion: this._version,
    };
  }

  credit(money: Money, now: Date = new Date()): WalletLegDraft {
    this.assertSameCurrency(money);
    const balanceBefore = this._balance;
    this._balance = balanceBefore.add(money);
    this._version += 1;
    this._updatedAt = now;
    return {
      walletId: this.id,
      direction: LedgerDirection.Credit,
      amount: money,
      balanceBefore,
      balanceAfter: this._balance,
      walletVersion: this._version,
    };
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
