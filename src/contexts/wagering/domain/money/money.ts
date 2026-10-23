import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../errors/domain-errors';
import { Currency } from './currency';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

/** DTO do README §6.1 — string decimal, nunca `number`. */
export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

const AMOUNT_PATTERN = /^-?\d{1,17}(\.\d{1,2})?$/;

/**
 * Value Object monetário imutável, escala fixa 2 (ADR-08).
 * Entradas inválidas (NaN/Infinity/científica/vazio/>2 casas) são rejeitadas.
 * Negativos são permitidos internamente (ex.: `difference` da reconciliação) e
 * rejeitados apenas nos contratos de entrada (DTO).
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('MoneyProps ausente');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string' || amount.length === 0) {
      throw new InvalidMoneyError('amount deve ser string decimal não vazia');
    }
    if (amount.trim() !== amount) {
      throw new InvalidMoneyError('amount não pode conter espaços');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `amount "${amount}" fora do formato decimal com até 2 casas`,
      );
    }
    // A validação ISO-4217 fica no Value Object `Currency` (fonte única).
    let currencyCode: string;
    try {
      currencyCode = Currency.of(currency).code;
    } catch {
      throw new InvalidMoneyError(`currency "${String(currency)}" não é ISO-4217`);
    }
    const value = new Decimal(amount);
    if (!value.isFinite()) {
      throw new InvalidMoneyError('amount não finito');
    }
    return new Money(value, currencyCode);
  }

  static of(amount: string, currency: string): Money {
    return Money.from({ amount, currency });
  }

  static zero(currency: string): Money {
    return Money.of('0.00', currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  abs(): Money {
    return new Money(this.value.abs(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isLessThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThanOrEqualTo(other.value);
  }

  equals(other: Money): boolean {
    if (this.currency !== other.currency) return false;
    return this.value.equals(other.value);
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.value.lessThan(other.value)) return -1;
    if (this.value.greaterThan(other.value)) return 1;
    return 0;
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
