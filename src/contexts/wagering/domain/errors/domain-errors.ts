import type { FailureCode } from '../transaction/failure-code';

/** Base de todos os erros de domínio (puros: sem HTTP, sem ORM). */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(detail: string) {
    super(`valor monetário inválido: ${detail}`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, actual: string) {
    super(`moeda divergente: esperada ${expected}, recebida ${actual}`);
  }
}

export class UnsupportedCurrencyError extends DomainError {
  readonly code = 'UNSUPPORTED_CURRENCY';

  constructor(currency: string) {
    super(`moeda não suportada: ${currency}`);
  }
}

export class InvalidIdentifierError extends DomainError {
  readonly code = 'VALIDATION_FAILED';

  constructor(field: string, detail: string) {
    super(`identificador inválido em ${field}: ${detail}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(balance: string, requested: string, currency: string) {
    super(`saldo insuficiente: ${balance} ${currency}, solicitado ${requested} ${currency}`);
  }
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(current: string, action: string) {
    super(`transição inválida: transação em ${current} não pode sofrer ${action}`);
  }
}

export class ReferenceRequiredError extends DomainError {
  readonly code = 'REFERENCE_REQUIRED';

  constructor(kind: string) {
    super(`${kind} exige referenceExternalTransactionId`);
  }
}

export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(key: string) {
    super(`idempotency key ${key} já usada com payload divergente`);
  }
}

export class WalletAlreadyExistsError extends DomainError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`wallet já existente para player ${playerId} na moeda ${currency}`);
  }
}

export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_FAILED';

  constructor(detail: string) {
    super(detail);
  }
}

export class LedgerArithmeticError extends DomainError {
  readonly code = 'INTERNAL_INCONSISTENCY';

  constructor(detail: string) {
    super(`aritmética do lançamento inválida: ${detail}`);
  }
}

export class JournalCompositionError extends DomainError {
  readonly code = 'INTERNAL_INCONSISTENCY';

  constructor(detail: string) {
    super(`journal inválido: ${detail}`);
  }
}

export class RejectedByRuleError extends DomainError {
  readonly code: string;

  constructor(readonly failureCode: FailureCode, message: string) {
    super(message);
    this.code = failureCode;
  }
}
