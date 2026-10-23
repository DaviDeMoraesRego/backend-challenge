import { UnsupportedCurrencyError } from '../errors/domain-errors';

/** Allow-list configurável (env `SUPPORTED_CURRENCIES`). */
export type SupportedCurrencies = ReadonlySet<string>;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Value Object de moeda ISO-4217 (Req. B). */
export class Currency {
  private constructor(public readonly code: string) {}

  static of(code: string, supported?: SupportedCurrencies): Currency {
    if (typeof code !== 'string' || !CURRENCY_PATTERN.test(code)) {
      throw new UnsupportedCurrencyError(String(code));
    }
    if (supported && !supported.has(code)) {
      throw new UnsupportedCurrencyError(code);
    }
    return new Currency(code);
  }

  static isSupported(code: string, supported: SupportedCurrencies): boolean {
    return CURRENCY_PATTERN.test(code) && supported.has(code);
  }

  equals(other: Currency): boolean {
    return this.code === other.code;
  }

  toString(): string {
    return this.code;
  }
}

export function parseSupportedCurrencies(raw: string): SupportedCurrencies {
  const codes = raw
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code.length > 0);
  return new Set(codes);
}
