import { describe, expect, it } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
} from '../../src/contexts/wagering/domain/errors/domain-errors';
import { LedgerDirection } from '../../src/contexts/wagering/domain/ledger/ledger-direction';
import { Money } from '../../src/contexts/wagering/domain/money/money';
import { Wallet } from '../../src/contexts/wagering/domain/wallet/wallet';
import { NOW, PLAYER_ID, makeWallet } from '../helpers/domain-factories';

describe('Wallet (UT-09…UT-14)', () => {
  it('UT-09 open cria saldo zero e version 1', () => {
    const wallet = Wallet.open({
      id: 'w1',
      playerId: PLAYER_ID,
      currency: 'BRL',
      now: NOW,
    });
    expect(wallet.balance.toString()).toBe('0.00');
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(NOW);
  });

  it('UT-10 debit: insuficiente lança, valor exato passa, moeda divergente lança', () => {
    const wallet = makeWallet({ balance: '100.00' });
    expect(() => wallet.debit(Money.of('100.01', 'BRL'), NOW)).toThrow(
      InsufficientFundsError,
    );
    expect(() => wallet.debit(Money.of('10.00', 'USD'), NOW)).toThrow(
      CurrencyMismatchError,
    );
    const leg = wallet.debit(Money.of('100.00', 'BRL'), NOW);
    expect(leg.balanceAfter.toString()).toBe('0.00');
  });

  it('UT-11 version incrementa somente quando o saldo muda e o rascunho é balanceado', () => {
    const wallet = makeWallet({ balance: '100.00', version: 1 });
    const debit = wallet.debit(Money.of('25.00', 'BRL'), NOW);
    expect(wallet.version).toBe(2);
    expect(debit.walletVersion).toBe(2);
    expect(debit.direction).toBe(LedgerDirection.Debit);
    expect(debit.balanceBefore.subtract(debit.amount).equals(debit.balanceAfter)).toBe(
      true,
    );

    const credit = wallet.credit(Money.of('10.00', 'BRL'), NOW);
    expect(wallet.version).toBe(3);
    expect(credit.balanceBefore.add(credit.amount).equals(credit.balanceAfter)).toBe(
      true,
    );
  });

  it('UT-12 invariante de domínio: duas wallets com mesmo player+currency são detectáveis pelo chamador', () => {
    const first = Wallet.open({ id: 'w1', playerId: PLAYER_ID, currency: 'BRL', now: NOW });
    const second = Wallet.open({ id: 'w2', playerId: PLAYER_ID, currency: 'BRL', now: NOW });
    // a unicidade real é do banco (uq_wallets_player_currency); o domínio expõe a chave
    expect(`${first.playerId}:${first.currency}`).toBe(
      `${second.playerId}:${second.currency}`,
    );
    expect(first.id).not.toBe(second.id);
  });

  it('UT-13 rehydrate não revalida transições', () => {
    const wallet = Wallet.rehydrate({
      id: 'w1',
      playerId: PLAYER_ID,
      providerId: null,
      currency: 'BRL',
      balance: Money.of('20.00', 'BRL'),
      version: 7,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toString()).toBe('20.00');
  });

  it('UT-14 WalletLegDraft mantém balanceBefore ± amount === balanceAfter', () => {
    const wallet = makeWallet({ balance: '100.00' });
    const leg = wallet.debit(Money.of('80.00', 'BRL'), NOW);
    expect(leg.balanceAfter.equals(leg.balanceBefore.subtract(leg.amount))).toBe(true);
    expect(leg.walletId).toBe(wallet.id);
  });
});
