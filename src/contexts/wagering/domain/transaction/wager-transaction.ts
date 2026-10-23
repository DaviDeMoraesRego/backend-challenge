import { InvalidTransactionStateError } from '../errors/domain-errors';
import { LedgerDirection } from '../ledger/ledger-direction';
import { Money } from '../money/money';
import { FailureCode } from './failure-code';
import {
  affectsBalance as kindAffectsBalance,
  requiresReference as kindRequiresReference,
  WagerTransactionKind,
} from './wager-transaction-kind';
import {
  isTerminalStatus,
  WagerTransactionStatus,
} from './wager-transaction-status';

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  /** NULL apenas para rejeições auditáveis de wallet inexistente. */
  readonly walletId: string | null;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  /** id no provedor — não o id interno */
  readonly referenceExternalTransactionId?: string;
  readonly createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string;
  readonly failureCode?: FailureCode;
  readonly resultingBalance?: Money;
  readonly processedAt?: Date;
  readonly attempts: number;
  readonly nextAttemptAt?: Date;
}

/**
 * Aggregate Root do ciclo de vida/idempotência.
 * Nasce em PENDING e só é commitada em estado final (ADR-03): PENDING nunca é commitado.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string | null,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _resultingBalance?: Money,
    private _processedAt?: Date,
    private _attempts = 0,
    private _nextAttemptAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.resultingBalance,
      state.processedAt,
      state.attempts,
      state.nextAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get resultingBalance(): Money | undefined {
    return this._resultingBalance;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    resultingBalance: Money | undefined,
  ): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._resultingBalance = resultingBalance;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
    this._failureCode = undefined;
  }

  markPendingReference(at: Date, nextAttemptAt: Date): void {
    this.assertNotTerminal('markPendingReference');
    this._status = WagerTransactionStatus.PendingReference;
    this._processedAt = at;
    this._nextAttemptAt = nextAttemptAt;
    this._attempts += 1;
  }

  reject(code: FailureCode, at: Date, resultingBalance: Money | undefined): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultingBalance = resultingBalance;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  scheduleNextAttempt(attempts: number, nextAt: Date): void {
    this._attempts = attempts;
    this._nextAttemptAt = nextAt;
  }

  isTerminal(): boolean {
    return isTerminalStatus(this._status);
  }

  affectsBalance(): boolean {
    return kindAffectsBalance(this.kind);
  }

  requiresReference(): boolean {
    return kindRequiresReference(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction | null): LedgerDirection | null {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        return null;
      case WagerTransactionKind.Rollback:
        if (!reference) return null;
        return reference.kind === WagerTransactionKind.Bet
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      default:
        return null;
    }
  }

  private assertNotTerminal(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, action);
    }
  }
}
