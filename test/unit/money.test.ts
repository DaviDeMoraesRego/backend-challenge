import { describe, expect, it } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  UnsupportedCurrencyError,
} from '../../src/contexts/wagering/domain/errors/domain-errors';
import { Currency, parseSupportedCurrencies } from '../../src/contexts/wagering/domain/money/currency';
import { Money } from '../../src/contexts/wagering/domain/money/money';

const brl = (amount: string): Money => Money.of(amount, 'BRL');

describe('Money (UT-01…UT-08)', () => {
  it('UT-01 soma, subtração e negação são exatas na escala 2', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).toString()).toBe('20.00');
    expect(brl('25.55').negate().toString()).toBe('-25.55');
    expect(brl('25.555'.slice(0, 5)).toString()).toBe('25.55');
  });

  it('UT-02 rejeita NaN, Infinity, notação científica, vazio e >2 casas', () => {
    for (const invalid of [
      'NaN',
      'Infinity',
      '1e5',
      '1.234',
      '',
      ' ',
      '12,34',
      '0x10',
      '.5',
      '5.',
      '--5',
    ]) {
      expect(() => brl(invalid)).toThrow(InvalidMoneyError);
    }
  });

  it('UT-03 serializa sempre com 2 casas e normaliza a entrada', () => {
    expect(brl('25').toString()).toBe('25.00');
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('0').toString()).toBe('0.00');
    expect(brl('-0').toString()).toBe('0.00');
  });

  it('UT-04 operações entre moedas diferentes lançam CurrencyMismatchError', () => {
    expect(() => brl('1.00').add(Money.of('1.00', 'USD'))).toThrow(
      CurrencyMismatchError,
    );
    expect(() => brl('1.00').isLessThan(Money.of('1.00', 'USD'))).toThrow(
      CurrencyMismatchError,
    );
    expect(brl('1.00').equals(Money.of('1.00', 'USD'))).toBe(false);
  });

  it('UT-05 permite negativos internamente (diferença de reconciliação)', () => {
    const difference = brl('20.00').subtract(brl('25.00'));
    expect(difference.isNegative()).toBe(true);
    expect(difference.toString()).toBe('-5.00');
  });

  it('UT-06 allow-list de moedas (BRL/USD ok, XXX rejeita)', () => {
    const supported = parseSupportedCurrencies('BRL,USD');
    expect(Currency.of('BRL', supported).code).toBe('BRL');
    expect(Currency.of('USD', supported).code).toBe('USD');
    expect(() => Currency.of('XXX', supported)).toThrow(UnsupportedCurrencyError);
    expect(() => Currency.of('brl', supported)).toThrow(UnsupportedCurrencyError);
    expect(Currency.isSupported('XXX', supported)).toBe(false);
  });

  it('UT-07 é imutável: operações não alteram os operandos', () => {
    const left = brl('10.00');
    const right = brl('5.00');
    left.add(right);
    left.subtract(right);
    expect(left.toString()).toBe('10.00');
    expect(right.toString()).toBe('5.00');
  });

  it('UT-08 respeita limites de magnitude (19,2)', () => {
    const max = brl('99999999999999999.99');
    expect(max.toString()).toBe('99999999999999999.99');
    expect(() => brl('999999999999999999.99')).toThrow(InvalidMoneyError);
  });
});
