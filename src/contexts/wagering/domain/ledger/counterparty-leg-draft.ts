import { Money } from '../money/money';
import { AccountRef } from './account-ref';
import { LedgerDirection } from './ledger-direction';

/** Rascunho da perna de contrapartida — sem leitura/escrita de saldo (ADR-02). */
export interface CounterpartyLegDraft {
  readonly account: AccountRef;
  readonly direction: LedgerDirection;
  readonly amount: Money;
}
