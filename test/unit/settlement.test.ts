import { describe, expect, it } from 'bun:test';
import { Journal } from '../../src/contexts/wagering/domain/ledger/journal';
import { CounterpartyLedgerEntry } from '../../src/contexts/wagering/domain/ledger/counterparty-ledger-entry';
import { WalletLedgerEntry } from '../../src/contexts/wagering/domain/ledger/wallet-ledger-entry';
import { LedgerDirection } from '../../src/contexts/wagering/domain/ledger/ledger-direction';
import { openingEquityAccount } from '../../src/contexts/wagering/domain/ledger/account-ref';
import {
  JournalCompositionError,
  LedgerArithmeticError,
} from '../../src/contexts/wagering/domain/errors/domain-errors';
import { Money } from '../../src/contexts/wagering/domain/money/money';
import { WagerSettlementService } from '../../src/contexts/wagering/domain/services/wager-settlement.service';
import {
  FAILURE_CODE_ACTION,
  FailureCode,
} from '../../src/contexts/wagering/domain/transaction/failure-code';
import { WagerTransactionKind } from '../../src/contexts/wagering/domain/transaction/wager-transaction-kind';
import {
  NOW,
  OTHER_PLAYER_ID,
  WALLET_ID,
  makeProcessedReference,
  makeRejectedReference,
  makeTransaction,
  makeWallet,
} from '../helpers/domain-factories';

const service = new WagerSettlementService();

describe('WagerSettlementService — tabela kind × referência (UT-21…UT-24, UT-25…UT-46)', () => {
  it('BET com saldo suficiente: PROCESSED com perna DEBIT e contrapartida CREDIT', () => {
    const wallet = makeWallet({ balance: '100.00' });
    const decision = service.settle({
      wallet,
      transaction: makeTransaction({ kind: WagerTransactionKind.Bet, amount: '25.00' }),
      reference: null,
      reversalAlreadyApplied: false,
      now: NOW,
    });

    expect(decision.outcome).toBe('PROCESSED');
    if (decision.outcome !== 'PROCESSED') throw new Error('unreachable');
    expect(decision.resultingBalance.toString()).toBe('75.00');
    expect(decision.walletVersion).toBe(2);
    expect(decision.journal?.walletLeg.direction).toBe(LedgerDirection.Debit);
    expect(decision.journal?.counterpartyLeg.direction).toBe(LedgerDirection.Credit);
    expect(decision.journal?.currency).toBe('BRL');
    expect(wallet.balance.toString()).toBe('75.00');
  });

  it('BET sem saldo: REJECTED INSUFFICIENT_FUNDS e wallet intocada', () => {
    const wallet = makeWallet({ balance: '20.00' });
    const decision = service.settle({
      wallet,
      transaction: makeTransaction({ kind: WagerTransactionKind.Bet, amount: '80.00' }),
      reference: null,
      reversalAlreadyApplied: false,
      now: NOW,
    });
    expect(decision).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.InsufficientFunds,
    });
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(1);
  });

  it('WIN sem referência e WIN com referência BET válida são PROCESSED com CREDIT', () => {
    for (const reference of [null, makeProcessedReference({ amount: '25.00' })]) {
      const wallet = makeWallet({ balance: '20.00' });
      const win = makeTransaction({
        kind: WagerTransactionKind.Win,
        amount: '25.00',
        referenceExternalTransactionId: reference ? 'ext-ref' : undefined,
      });
      const decision = service.settle({
        wallet,
        transaction: win,
        reference,
        reversalAlreadyApplied: false,
        now: NOW,
      });
      expect(decision.outcome).toBe('PROCESSED');
      if (decision.outcome !== 'PROCESSED') throw new Error('unreachable');
      expect(wallet.balance.toString()).toBe('45.00');
      expect(decision.journal?.walletLeg.direction).toBe(LedgerDirection.Credit);
    }
  });

  it('WIN com referência ausente permanece PENDING_REFERENCE (conservador)', () => {
    const decision = service.settle({
      wallet: makeWallet(),
      transaction: makeTransaction({
        kind: WagerTransactionKind.Win,
        referenceExternalTransactionId: 'nao-existe',
      }),
      reference: null,
      reversalAlreadyApplied: false,
      now: NOW,
    });
    expect(decision.outcome).toBe('PENDING_REFERENCE');
  });

  it('LOSS é PROCESSED sem pernas e sem mover saldo', () => {
    const wallet = makeWallet({ balance: '100.00' });
    const decision = service.settle({
      wallet,
      transaction: makeTransaction({ kind: WagerTransactionKind.Loss, amount: '25.00' }),
      reference: null,
      reversalAlreadyApplied: false,
      now: NOW,
    });
    expect(decision.outcome).toBe('PROCESSED');
    if (decision.outcome !== 'PROCESSED') throw new Error('unreachable');
    expect(decision.journal).toBeNull();
    expect(decision.walletVersion).toBe(1);
    expect(wallet.balance.toString()).toBe('100.00');
  });

  it('REFUND de BET PROCESSED: PROCESSED com CREDIT', () => {
    const reference = makeProcessedReference({ amount: '25.00' });
    const wallet = makeWallet({ balance: '75.00' });
    const decision = service.settle({
      wallet,
      transaction: makeTransaction({
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        referenceExternalTransactionId: reference.externalTransactionId,
      }),
      reference,
      reversalAlreadyApplied: false,
      now: NOW,
    });
    expect(decision.outcome).toBe('PROCESSED');
    expect(wallet.balance.toString()).toBe('100.00');
  });

  it('REFUND/ROLLBACK sem referência: REJECTED REFERENCE_REQUIRED', () => {
    for (const kind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
      const decision = service.settle({
        wallet: makeWallet(),
        transaction: makeTransaction({ kind }),
        reference: null,
        reversalAlreadyApplied: false,
        now: NOW,
      });
      expect(decision).toEqual({
        outcome: 'REJECTED',
        failureCode: FailureCode.ReferenceRequired,
      });
    }
  });

  it('REFUND de WIN: REJECTED INVALID_REFERENCE_KIND', () => {
    const reference = makeProcessedReference({ kind: WagerTransactionKind.Win });
    const decision = service.settle({
      wallet: makeWallet(),
      transaction: makeTransaction({
        kind: WagerTransactionKind.Refund,
        amount: reference.money.toString(),
        referenceExternalTransactionId: reference.externalTransactionId,
      }),
      reference,
      reversalAlreadyApplied: false,
      now: NOW,
    });
    expect(decision).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.InvalidReferenceKind,
    });
  });

  it('referência terminal REJECTED: REJECTED REFERENCE_NOT_REVERSIBLE', () => {
    const reference = makeRejectedReference();
    const decision = service.settle({
      wallet: makeWallet(),
      transaction: makeTransaction({
        kind: WagerTransactionKind.Refund,
        amount: reference.money.toString(),
        referenceExternalTransactionId: reference.externalTransactionId,
      }),
      reference,
      reversalAlreadyApplied: false,
      now: NOW,
    });
    expect(decision).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.ReferenceNotReversible,
    });
  });

  it('referência de outra wallet/player: REJECTED REFERENCE_SCOPE_MISMATCH', () => {
    const reference = makeProcessedReference({ walletId: 'outra-wallet' });
    const decision = service.settle({
      wallet: makeWallet(),
      transaction: makeTransaction({
        kind: WagerTransactionKind.Refund,
        amount: reference.money.toString(),
        referenceExternalTransactionId: reference.externalTransactionId,
      }),
      reference,
      reversalAlreadyApplied: false,
      now: NOW,
    });
    expect(decision).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.ReferenceScopeMismatch,
    });

    const otherPlayerRef = makeProcessedReference({ playerId: OTHER_PLAYER_ID });
    const second = service.settle({
      wallet: makeWallet(),
      transaction: makeTransaction({
        kind: WagerTransactionKind.Refund,
        amount: otherPlayerRef.money.toString(),
        referenceExternalTransactionId: otherPlayerRef.externalTransactionId,
      }),
      reference: otherPlayerRef,
      reversalAlreadyApplied: false,
      now: NOW,
    });
    expect(second).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.ReferenceScopeMismatch,
    });
  });

  it('valor diferente da referência: REJECTED AMOUNT_MISMATCH', () => {
    const reference = makeProcessedReference({ amount: '25.00' });
    const decision = service.settle({
      wallet: makeWallet(),
      transaction: makeTransaction({
        kind: WagerTransactionKind.Refund,
        amount: '10.00',
        referenceExternalTransactionId: reference.externalTransactionId,
      }),
      reference,
      reversalAlreadyApplied: false,
      now: NOW,
    });
    expect(decision).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.AmountMismatch,
    });
  });

  it('reversão já aplicada: REJECTED REVERSAL_ALREADY_APPLIED', () => {
    const reference = makeProcessedReference({ amount: '25.00' });
    const decision = service.settle({
      wallet: makeWallet(),
      transaction: makeTransaction({
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        referenceExternalTransactionId: reference.externalTransactionId,
      }),
      reference,
      reversalAlreadyApplied: true,
      now: NOW,
    });
    expect(decision).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.ReversalAlreadyApplied,
    });
  });

  it('ROLLBACK de BET credita; de WIN debita; de REFUND debita', () => {
    const bet = makeProcessedReference({ amount: '25.00' });
    const creditWallet = makeWallet({ balance: '75.00' });
    const creditDecision = service.settle({
      wallet: creditWallet,
      transaction: makeTransaction({
        kind: WagerTransactionKind.Rollback,
        amount: '25.00',
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      reference: bet,
      reversalAlreadyApplied: false,
      now: NOW,
    });
    expect(creditDecision.outcome).toBe('PROCESSED');
    expect(creditWallet.balance.toString()).toBe('100.00');

    const win = makeProcessedReference({ kind: WagerTransactionKind.Win, amount: '25.00' });
    const debitWallet = makeWallet({ balance: '100.00' });
    const debitDecision = service.settle({
      wallet: debitWallet,
      transaction: makeTransaction({
        kind: WagerTransactionKind.Rollback,
        amount: '25.00',
        referenceExternalTransactionId: win.externalTransactionId,
      }),
      reference: win,
      reversalAlreadyApplied: false,
      now: NOW,
    });
    expect(debitDecision.outcome).toBe('PROCESSED');
    expect(debitWallet.balance.toString()).toBe('75.00');

    const refund = makeProcessedReference({
      kind: WagerTransactionKind.Refund,
      amount: '25.00',
    });
    const refundWallet = makeWallet({ balance: '50.00' });
    const refundDecision = service.settle({
      wallet: refundWallet,
      transaction: makeTransaction({
        kind: WagerTransactionKind.Rollback,
        amount: '25.00',
        referenceExternalTransactionId: refund.externalTransactionId,
      }),
      reference: refund,
      reversalAlreadyApplied: false,
      now: NOW,
    });
    expect(refundDecision.outcome).toBe('PROCESSED');
    expect(refundWallet.balance.toString()).toBe('25.00');
  });

  it('UT-22 REVERSAL_INSUFFICIENT_FUNDS é distinto de INSUFFICIENT_FUNDS (README regra 9)', () => {
    const win = makeProcessedReference({ kind: WagerTransactionKind.Win, amount: '25.00' });
    const wallet = makeWallet({ balance: '10.00' });
    const decision = service.settle({
      wallet,
      transaction: makeTransaction({
        kind: WagerTransactionKind.Rollback,
        amount: '25.00',
        referenceExternalTransactionId: win.externalTransactionId,
      }),
      reference: win,
      reversalAlreadyApplied: false,
      now: NOW,
    });
    expect(decision).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.ReversalInsufficientFunds,
    });
    expect(FailureCode.ReversalInsufficientFunds).not.toBe(FailureCode.InsufficientFunds);
    expect(wallet.balance.toString()).toBe('10.00');
  });

  it('ROLLBACK de LOSS: REJECTED INVALID_REFERENCE_KIND', () => {
    const loss = makeProcessedReference({ kind: WagerTransactionKind.Loss, amount: '25.00' });
    const decision = service.settle({
      wallet: makeWallet(),
      transaction: makeTransaction({
        kind: WagerTransactionKind.Rollback,
        amount: '25.00',
        referenceExternalTransactionId: loss.externalTransactionId,
      }),
      reference: loss,
      reversalAlreadyApplied: false,
      now: NOW,
    });
    expect(decision).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.InvalidReferenceKind,
    });
  });

  it('referência ainda pendente: permanece PENDING_REFERENCE', () => {
    const pendingRef = makeTransaction({ kind: WagerTransactionKind.Bet });
    const decision = service.settle({
      wallet: makeWallet(),
      transaction: makeTransaction({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: pendingRef.externalTransactionId,
      }),
      reference: pendingRef,
      reversalAlreadyApplied: false,
      now: NOW,
    });
    expect(decision.outcome).toBe('PENDING_REFERENCE');
  });

  it('OPENING externo é rejeitado; OPENING interno usa contrapartida OPENING_EQUITY', () => {
    const external = service.settle({
      wallet: makeWallet(),
      transaction: makeTransaction({
        kind: WagerTransactionKind.Opening,
        amount: '1000.00',
      }),
      reference: null,
      reversalAlreadyApplied: false,
      now: NOW,
    });
    expect(external).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.OpeningNotAllowed,
    });

    const wallet = makeWallet({ balance: '0.00' });
    const internal = service.settle({
      wallet,
      transaction: makeTransaction({
        kind: WagerTransactionKind.Opening,
        amount: '1000.00',
      }),
      reference: null,
      reversalAlreadyApplied: false,
      now: NOW,
      internal: true,
    });
    expect(internal.outcome).toBe('PROCESSED');
    if (internal.outcome !== 'PROCESSED') throw new Error('unreachable');
    expect(internal.journal?.counterpartyLeg.account).toEqual(
      openingEquityAccount('BRL'),
    );
    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.version).toBe(2);
  });

  it('moeda divergente e player divergente são rejeições de negócio', () => {
    const currencyMismatch = service.settle({
      wallet: makeWallet({ currency: 'USD' }),
      transaction: makeTransaction({ kind: WagerTransactionKind.Bet, currency: 'BRL' }),
      reference: null,
      reversalAlreadyApplied: false,
      now: NOW,
    });
    expect(currencyMismatch).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.CurrencyMismatch,
    });

    const playerMismatch = service.settle({
      wallet: makeWallet({ playerId: OTHER_PLAYER_ID }),
      transaction: makeTransaction({ kind: WagerTransactionKind.Bet }),
      reference: null,
      reversalAlreadyApplied: false,
      now: NOW,
    });
    expect(playerMismatch).toEqual({
      outcome: 'REJECTED',
      failureCode: FailureCode.PlayerMismatch,
    });
  });

  it('UT-23 WalletLedgerEntry valida aritmética; contrapartida não tem campos de saldo', () => {
    const journal = Journal.create({
      id: 'j1',
      transactionId: 'tx-1',
      createdAt: NOW,
      walletLeg: {
        walletId: WALLET_ID,
        direction: LedgerDirection.Debit,
        amount: Money.of('25.00', 'BRL'),
        balanceBefore: Money.of('100.00', 'BRL'),
        balanceAfter: Money.of('75.00', 'BRL'),
        walletVersion: 2,
      },
      counterpartyLeg: {
        account: openingEquityAccount('BRL'),
        direction: LedgerDirection.Credit,
        amount: Money.of('25.00', 'BRL'),
      },
    });
    expect(() =>
      WalletLedgerEntry.create({
        id: 'e1',
        journalId: journal.id,
        walletId: WALLET_ID,
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: Money.of('25.00', 'BRL'),
        balanceBefore: Money.of('100.00', 'BRL'),
        balanceAfter: Money.of('100.00', 'BRL'),
        walletVersion: 2,
        createdAt: NOW,
      }),
    ).toThrow(LedgerArithmeticError);

    const counterparty = CounterpartyLedgerEntry.create({
      id: 'cp-1',
      journalId: journal.id,
      transactionId: 'tx-1',
      account: openingEquityAccount('BRL'),
      direction: LedgerDirection.Debit,
      money: Money.of('25.00', 'BRL'),
      createdAt: NOW,
    });
    expect(Object.keys(counterparty)).not.toContain('balanceBefore');
    expect(Object.keys(counterparty)).not.toContain('balanceAfter');
  });

  it('UT-24 Journal protege a partida dobrada (2 pernas opostas, mesmo valor/moeda)', () => {
    const debitLeg = {
      walletId: WALLET_ID,
      direction: LedgerDirection.Debit,
      amount: Money.of('25.00', 'BRL'),
      balanceBefore: Money.of('100.00', 'BRL'),
      balanceAfter: Money.of('75.00', 'BRL'),
      walletVersion: 2,
    };
    const creditLeg = {
      account: openingEquityAccount('BRL'),
      direction: LedgerDirection.Credit,
      amount: Money.of('25.00', 'BRL'),
    };

    const journal = Journal.create({
      id: 'j1',
      transactionId: 'tx-1',
      createdAt: NOW,
      walletLeg: debitLeg,
      counterpartyLeg: creditLeg,
    });
    // a moeda é derivada das pernas, não informada à parte
    expect(journal.currency).toBe('BRL');

    // mesma direção nas duas pernas → não é partida dobrada
    expect(() =>
      Journal.create({
        id: 'j2',
        transactionId: 'tx-1',
        createdAt: NOW,
        walletLeg: debitLeg,
        counterpartyLeg: { ...creditLeg, direction: LedgerDirection.Debit },
      }),
    ).toThrow(JournalCompositionError);

    // valores divergentes
    expect(() =>
      Journal.create({
        id: 'j3',
        transactionId: 'tx-1',
        createdAt: NOW,
        walletLeg: debitLeg,
        counterpartyLeg: { ...creditLeg, amount: Money.of('24.99', 'BRL') },
      }),
    ).toThrow(JournalCompositionError);

    // moedas divergentes
    expect(() =>
      Journal.create({
        id: 'j4',
        transactionId: 'tx-1',
        createdAt: NOW,
        walletLeg: debitLeg,
        counterpartyLeg: { ...creditLeg, amount: Money.of('25.00', 'USD') },
      }),
    ).toThrow(JournalCompositionError);
  });

  it('UT-47 failureCodes são estáveis e possuem ação definida', () => {
    const codes = Object.values(FailureCode) as string[];
    expect(codes).toContain('INSUFFICIENT_FUNDS');
    expect(codes).toContain('REVERSAL_INSUFFICIENT_FUNDS');
    expect(codes).toContain('IDEMPOTENCY_CONFLICT');
    for (const code of codes) {
      expect(typeof FAILURE_CODE_ACTION[code as FailureCode]).toBe('string');
    }
    expect(FAILURE_CODE_ACTION[FailureCode.InsufficientFunds]).toBe('RETRY_LATER');
    expect(FAILURE_CODE_ACTION[FailureCode.ReversalInsufficientFunds]).toBe('GIVE_UP');
    expect(FAILURE_CODE_ACTION[FailureCode.InfraTemporary]).toBe('RETRY');
  });
});
