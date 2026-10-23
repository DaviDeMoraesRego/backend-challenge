import { AccountRef } from './account-ref';
import { LedgerDirection } from './ledger-direction';
import { Money } from '../money/money';

export interface CreateCounterpartyEntryProps {
  readonly id: string;
  readonly journalId: string;
  readonly transactionId: string;
  readonly account: AccountRef;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly createdAt: Date;
}

/**
 * Perna de contrapartida: espelho estrutural da perna de wallet, **sem** campos de
 * saldo. A conta nunca é atualizada (append-only) → ausência de hot row.
 */
export class CounterpartyLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly journalId: string,
    public readonly transactionId: string,
    public readonly account: AccountRef,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateCounterpartyEntryProps): CounterpartyLedgerEntry {
    return new CounterpartyLedgerEntry(
      props.id,
      props.journalId,
      props.transactionId,
      props.account,
      props.direction,
      props.money,
      props.createdAt,
    );
  }
}
