import {
  Catch,
  HttpException,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { CONFIG, LOGGER, METRICS } from '../../../../../config/tokens';
import type { AppConfig } from '../../../../../config/env';
import { DomainError } from '../../../domain/errors/domain-errors';
import type { LoggerPort, MetricsPort } from '../../../application/ports/misc-ports';
import {
  TokenExpiredError,
  TokenInvalidError,
} from '../../../application/ports/provider-identity';
import { InvalidCursorError } from '../../../../../shared/cursor';
import { isTransientInfraError } from '../../messaging/error-classifier';
import {
  BadRequestError,
  BusinessRejectionError,
  ForbiddenError,
  InfraTemporaryError,
  NotFoundError,
  UnauthorizedError,
} from '../errors';

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  VALIDATION_FAILED: 400,
  INVALID_MONEY: 400,
  INVALID_CURSOR: 400,
  UNSUPPORTED_CURRENCY: 400,
  PAYLOAD_TOO_LARGE: 413,
  TOKEN_INVALID: 401,
  TOKEN_EXPIRED: 401,
  INSUFFICIENT_SCOPE: 403,
  PROVIDER_MISMATCH: 403,
  PROVIDER_REQUIRED: 403,
  WALLET_ALREADY_EXISTS: 409,
  IDEMPOTENCY_CONFLICT: 409,
  INSUFFICIENT_FUNDS: 422,
  REVERSAL_INSUFFICIENT_FUNDS: 422,
  CURRENCY_MISMATCH: 422,
  PLAYER_MISMATCH: 422,
  UNKNOWN_PROVIDER: 422,
  WALLET_NOT_FOUND: 422,
  OPENING_NOT_ALLOWED: 422,
  REFERENCE_REQUIRED: 422,
  REFERENCE_NOT_FOUND: 422,
  REFERENCE_NOT_REVERSIBLE: 422,
  REFERENCE_SCOPE_MISMATCH: 422,
  INVALID_REFERENCE_KIND: 422,
  AMOUNT_MISMATCH: 422,
  REVERSAL_ALREADY_APPLIED: 422,
  INTERNAL_INCONSISTENCY: 500,
  INVALID_TRANSACTION_STATE: 500,
  INFRA_TEMPORARY: 503,
};

const TITLES: Readonly<Record<string, string>> = {
  VALIDATION_FAILED: 'Validation failed',
  INVALID_CURSOR: 'Invalid cursor',
  UNSUPPORTED_CURRENCY: 'Unsupported currency',
  TOKEN_INVALID: 'Invalid token',
  TOKEN_EXPIRED: 'Expired token',
  INSUFFICIENT_SCOPE: 'Insufficient scope',
  PROVIDER_MISMATCH: 'Provider mismatch',
  PROVIDER_REQUIRED: 'Provider identity required',
  WALLET_ALREADY_EXISTS: 'Wallet already exists',
  IDEMPOTENCY_CONFLICT: 'Idempotency conflict',
  INSUFFICIENT_FUNDS: 'Insufficient funds',
  REVERSAL_INSUFFICIENT_FUNDS: 'Reversal would make the balance negative',
  WALLET_NOT_FOUND: 'Wallet not found',
  TRANSACTION_NOT_FOUND: 'Transaction not found',
  INTERNAL_ERROR: 'Internal error',
  INFRA_TEMPORARY: 'Temporarily unavailable',
};

interface ProblemBody extends Record<string, unknown> {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  traceId?: string;
}

const slug = (code: string): string => code.toLowerCase().replace(/_/g, '-');

/**
 * Único lugar que conhece HTTP (plans/06 §4.5): mapeia erros tipados para
 * RFC 9457 `application/problem+json`, sem stack trace nem SQL.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    @Inject(LOGGER) private readonly logger: LoggerPort,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const reply = context.getResponse<FastifyReply>();
    const request = context.getRequest<{
      url?: string;
      id?: string;
      headers?: Record<string, string | undefined>;
    }>();

    const mapped = this.mapException(exception);
    const traceId = request.id;
    const body: ProblemBody = {
      ...(mapped.extra ?? {}),
      type: `https://wagering.jungle/errors/${slug(mapped.code)}`,
      title: TITLES[mapped.code] ?? mapped.code,
      status: mapped.status,
      detail: mapped.detail,
      instance: request.url,
      code: mapped.code,
      traceId,
    };
    if (mapped.issues) body.issues = mapped.issues;

    if (mapped.status >= 500) {
      this.logger.error(
        {
          code: mapped.code,
          path: request.url,
          error: exception instanceof Error ? exception.message : String(exception),
        },
        'erro não mapeado (sem stack trace na resposta)',
      );
    }

    if (mapped.retryAfterSeconds !== undefined) {
      reply.header('retry-after', String(mapped.retryAfterSeconds));
    }
    if (mapped.wwwAuthenticate) {
      reply.header('www-authenticate', mapped.wwwAuthenticate);
    }

    reply
      .status(mapped.status)
      .header('content-type', 'application/problem+json')
      .send(body);
  }

  private mapException(exception: unknown): {
    status: number;
    code: string;
    detail?: string;
    issues?: unknown;
    extra?: Record<string, unknown>;
    retryAfterSeconds?: number;
    wwwAuthenticate?: string;
  } {
    if (exception instanceof BusinessRejectionError) {
      return {
        status: 422,
        code: exception.failureCode,
        detail: exception.message,
        extra: exception.payload,
      };
    }
    if (exception instanceof NotFoundError) {
      return { status: 404, code: exception.code, detail: exception.message };
    }
    if (exception instanceof UnauthorizedError) {
      return {
        status: 401,
        code: exception.code,
        detail: exception.message,
        wwwAuthenticate: `Bearer realm="wagering-api", error="invalid_token"`,
      };
    }
    if (exception instanceof ForbiddenError) {
      const suffix = exception.requiredScope
        ? `, error="insufficient_scope", scope="${exception.requiredScope}"`
        : ', error="insufficient_scope"';
      return {
        status: 403,
        code: exception.code,
        detail: exception.message,
        wwwAuthenticate: `Bearer realm="wagering-api"${suffix}`,
      };
    }
    if (exception instanceof BadRequestError) {
      return {
        status: STATUS_BY_CODE[exception.code] ?? 400,
        code: exception.code,
        detail: exception.message,
        issues: exception.issues,
      };
    }
    if (exception instanceof InfraTemporaryError) {
      return {
        status: 503,
        code: 'INFRA_TEMPORARY',
        detail: exception.message,
        retryAfterSeconds: exception.retryAfterSeconds,
      };
    }
    if (exception instanceof InvalidCursorError) {
      return { status: 400, code: 'INVALID_CURSOR', detail: exception.message };
    }
    if (exception instanceof ZodError) {
      return {
        status: 400,
        code: 'VALIDATION_FAILED',
        detail: 'payload inválido',
        issues: exception.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      };
    }
    if (exception instanceof TokenExpiredError) {
      return { status: 401, code: 'TOKEN_EXPIRED', detail: exception.message };
    }
    if (exception instanceof TokenInvalidError) {
      return { status: 401, code: 'TOKEN_INVALID', detail: exception.message };
    }
    if (exception instanceof DomainError) {
      const status = STATUS_BY_CODE[exception.code] ?? 422;
      return { status, code: exception.code, detail: exception.message };
    }
    // O `bodyLimit` do Fastify é barrado **antes** do pipeline do Nest, então o erro
    // chega cru (FST_*) e não como HttpException: sem este mapeamento viraria 500.
    if ((exception as { code?: unknown }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return {
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        detail: 'payload excede o limite de 16 KiB',
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_FAILED',
        detail: exception.message,
      };
    }

    // Conexão derrubada, lock timeout, 5xx do SDK: o provider deve reenviar com a
    // mesma Idempotency-Key — 503 (retry) é diferente de 500 (bug).
    if (isTransientInfraError(exception)) {
      return {
        status: 503,
        code: 'INFRA_TEMPORARY',
        detail: 'dependência temporariamente indisponível',
        retryAfterSeconds: 1,
      };
    }

    return {
      status: 500,
      code: 'INTERNAL_ERROR',
      detail: 'erro interno inesperado',
    };
  }
}
