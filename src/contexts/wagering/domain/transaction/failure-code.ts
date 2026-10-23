/** Taxonomia estável de `failureCode` (plans/02 §6, README §7.2). */
export enum FailureCode {
  ValidationFailed = 'VALIDATION_FAILED',
  UnsupportedCurrency = 'UNSUPPORTED_CURRENCY',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  UnknownProvider = 'UNKNOWN_PROVIDER',
  WalletNotFound = 'WALLET_NOT_FOUND',
  PlayerMismatch = 'PLAYER_MISMATCH',
  ProviderMismatch = 'PROVIDER_MISMATCH',
  OpeningNotAllowed = 'OPENING_NOT_ALLOWED',
  ReferenceRequired = 'REFERENCE_REQUIRED',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotReversible = 'REFERENCE_NOT_REVERSIBLE',
  ReferenceScopeMismatch = 'REFERENCE_SCOPE_MISMATCH',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  AmountMismatch = 'AMOUNT_MISMATCH',
  ReversalAlreadyApplied = 'REVERSAL_ALREADY_APPLIED',
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',
  WalletAlreadyExists = 'WALLET_ALREADY_EXISTS',
  InfraTemporary = 'INFRA_TEMPORARY',
  InternalInconsistency = 'INTERNAL_INCONSISTENCY',
}

/** Ação sugerida ao provider — decide se reenvia, corrige ou desiste. */
export type FailureAction = 'FIX' | 'RETRY' | 'RETRY_LATER' | 'GIVE_UP';

export const FAILURE_CODE_ACTION: Readonly<Record<FailureCode, FailureAction>> = {
  [FailureCode.ValidationFailed]: 'FIX',
  [FailureCode.UnsupportedCurrency]: 'FIX',
  [FailureCode.CurrencyMismatch]: 'FIX',
  [FailureCode.UnknownProvider]: 'FIX',
  [FailureCode.WalletNotFound]: 'FIX',
  [FailureCode.PlayerMismatch]: 'FIX',
  [FailureCode.ProviderMismatch]: 'FIX',
  [FailureCode.OpeningNotAllowed]: 'GIVE_UP',
  [FailureCode.ReferenceRequired]: 'FIX',
  [FailureCode.ReferenceNotFound]: 'GIVE_UP',
  [FailureCode.ReferenceNotReversible]: 'GIVE_UP',
  [FailureCode.ReferenceScopeMismatch]: 'FIX',
  [FailureCode.InvalidReferenceKind]: 'FIX',
  [FailureCode.AmountMismatch]: 'FIX',
  [FailureCode.ReversalAlreadyApplied]: 'GIVE_UP',
  [FailureCode.InsufficientFunds]: 'RETRY_LATER',
  [FailureCode.ReversalInsufficientFunds]: 'GIVE_UP',
  [FailureCode.IdempotencyConflict]: 'FIX',
  [FailureCode.WalletAlreadyExists]: 'FIX',
  [FailureCode.InfraTemporary]: 'RETRY',
  [FailureCode.InternalInconsistency]: 'GIVE_UP',
};

export function isFailureCode(value: string): value is FailureCode {
  return Object.prototype.hasOwnProperty.call(FAILURE_CODE_ACTION, value);
}
