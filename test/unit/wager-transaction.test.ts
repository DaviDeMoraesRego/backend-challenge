import { describe, expect, it } from 'bun:test';
import { InvalidTransactionStateError } from '../../src/contexts/wagering/domain/errors/domain-errors';
import { LedgerDirection } from '../../src/contexts/wagering/domain/ledger/ledger-direction';
import { Money } from '../../src/contexts/wagering/domain/money/money';
import { FailureCode } from '../../src/contexts/wagering/domain/transaction/failure-code';
import { WagerTransactionKind } from '../../src/contexts/wagering/domain/transaction/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/contexts/wagering/domain/transaction/wager-transaction-status';
import {
  NOW,
  WALLET_ID,
  makeProcessedReference,
  makeTransaction,
} from '../helpers/domain-factories';

describe('WagerTransaction (UT-15…UT-20)', () => {
  it('UT-15 nasce em PENDING e materializa a exigência de referência', () => {
    const bet = makeTransaction();
    expect(bet.status).toBe(WagerTransactionStatus.Pending);
    expect(bet.isTerminal()).toBe(false);

    const refund = makeTransaction({ kind: WagerTransactionKind.Refund });
    expect(refund.requiresReference()).toBe(true);
    // a rejeição por ausência de referência é **persistida** (plans/08 §4 premissa 2)
    expect(refund.referenceExternalTransactionId).toBeUndefined();
  });

  it('UT-16 qualquer transição a partir de estado terminal é erro de programação', () => {
    const terminals: Array<[string, () => ReturnType<typeof makeTransaction>]> = [
      [
        'PROCESSED',
        () => {
          const tx = makeTransaction();
          tx.markProcessed(undefined, NOW, Money.of('1.00', 'BRL'));
          return tx;
        },
      ],
      [
        'REJECTED',
        () => {
          const tx = makeTransaction();
          tx.reject(FailureCode.InsufficientFunds, NOW, Money.of('0.00', 'BRL'));
          return tx;
        },
      ],
      [
        'FAILED',
        () => {
          const tx = makeTransaction();
          tx.fail(FailureCode.InternalInconsistency, NOW);
          return tx;
        },
      ],
    ];

    for (const [, factory] of terminals) {
      const tx = factory();
      expect(tx.isTerminal()).toBe(true);
      expect(() => tx.markProcessed(undefined, NOW, undefined)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.markPendingReference(NOW, NOW)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.reject(FailureCode.InsufficientFunds, NOW, undefined)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.fail(FailureCode.InternalInconsistency, NOW)).toThrow(
        InvalidTransactionStateError,
      );
    }
  });

  it('UT-17 affectsBalance e requiresReference por kind', () => {
    expect(makeTransaction({ kind: WagerTransactionKind.Loss }).affectsBalance()).toBe(
      false,
    );
    expect(makeTransaction({ kind: WagerTransactionKind.Bet }).affectsBalance()).toBe(
      true,
    );
    expect(
      makeTransaction({ kind: WagerTransactionKind.Refund }).requiresReference(),
    ).toBe(true);
    expect(
      makeTransaction({ kind: WagerTransactionKind.Rollback }).requiresReference(),
    ).toBe(true);
    expect(makeTransaction({ kind: WagerTransactionKind.Win }).requiresReference()).toBe(
      false,
    );
  });

  it('UT-18 matchesPayload compara o hash canônico', () => {
    const tx = makeTransaction();
    expect(tx.matchesPayload(tx.payloadHash)).toBe(true);
    expect(tx.matchesPayload('outro-hash')).toBe(false);
  });

  it('UT-19 ledgerDirectionFor por kind e referência', () => {
    const bet = makeTransaction({ kind: WagerTransactionKind.Bet });
    const win = makeTransaction({ kind: WagerTransactionKind.Win });
    const loss = makeTransaction({ kind: WagerTransactionKind.Loss });
    const refund = makeTransaction({ kind: WagerTransactionKind.Refund });
    const rollback = makeTransaction({ kind: WagerTransactionKind.Rollback });
    const processedBet = makeProcessedReference({ amount: '25.00' });
    const processedWin = makeProcessedReference({ kind: WagerTransactionKind.Win });
    const processedRefund = makeProcessedReference({
      kind: WagerTransactionKind.Refund,
    });

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(loss.ledgerDirectionFor()).toBeNull();
    expect(refund.ledgerDirectionFor(processedBet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(processedBet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(processedWin)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(processedRefund)).toBe(LedgerDirection.Debit);
  });

  it('UT-20 markProcessed/reject/markPendingReference gravam snapshot e timestamps', () => {
    const processed = makeTransaction();
    processed.markProcessed('ref-id', NOW, Money.of('75.00', 'BRL'));
    expect(processed.status).toBe(WagerTransactionStatus.Processed);
    expect(processed.referenceTransactionId).toBe('ref-id');
    expect(processed.resultingBalance?.toString()).toBe('75.00');
    expect(processed.processedAt).toEqual(NOW);

    const rejected = makeTransaction();
    rejected.reject(FailureCode.InsufficientFunds, NOW, Money.of('20.00', 'BRL'));
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(rejected.resultingBalance?.toString()).toBe('20.00');

    const pending = makeTransaction();
    pending.markPendingReference(NOW, new Date(NOW.getTime() + 5000));
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    expect(pending.attempts).toBe(1);
    expect(pending.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 5000);
    expect(pending.walletId).toBe(WALLET_ID);
  });
});
