import type { FailureCode } from '../../domain/transaction/failure-code';

export type QueryNotFoundCode = 'WALLET_NOT_FOUND' | 'TRANSACTION_NOT_FOUND';

export class NotFoundError extends Error {
  constructor(
    public readonly code: QueryNotFoundCode,
    message: string,
  ) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends Error {
  constructor(
    public readonly code: 'TOKEN_INVALID' | 'TOKEN_EXPIRED',
    message: string,
  ) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  constructor(
    public readonly code: 'INSUFFICIENT_SCOPE' | 'PROVIDER_MISMATCH' | 'PROVIDER_REQUIRED',
    message: string,
    public readonly requiredScope?: string,
  ) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class BadRequestError extends Error {
  constructor(
    public readonly code: 'VALIDATION_FAILED' | 'INVALID_CURSOR' | 'UNSUPPORTED_CURRENCY' | 'PAYLOAD_TOO_LARGE',
    message: string,
    public readonly issues?: unknown,
  ) {
    super(message);
    this.name = 'BadRequestError';
  }
}

export class BusinessRejectionError extends Error {
  constructor(
    public readonly failureCode: FailureCode,
    message: string,
    public readonly payload: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BusinessRejectionError';
  }
}

export class InfraTemporaryError extends Error {
  constructor(message: string, public readonly retryAfterSeconds = 1) {
    super(message);
    this.name = 'InfraTemporaryError';
  }
}
