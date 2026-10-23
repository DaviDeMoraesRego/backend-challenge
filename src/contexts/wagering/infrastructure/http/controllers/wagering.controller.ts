import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  CONFIG,
  GET_TRANSACTION,
  GET_TRANSACTION_BY_EXTERNAL_ID,
  OPPORTUNISTIC_SETTLEMENT_TRIGGER,
  SUBMIT_WAGER_TRANSACTION,
  SUPPORTED_CURRENCIES,
} from '../../../../../config/tokens';
import type { AppConfig } from '../../../../../config/env';
import type { ProviderIdentity } from '../../../application/ports/provider-identity';
import type { SubmitWagerTransaction } from '../../../application/use-cases/submit-wager-transaction';
import type {
  GetTransaction,
  GetTransactionByExternalId,
} from '../../../application/use-cases/queries';
import type { SupportedCurrencies } from '../../../domain/money/currency';
import { FailureCode } from '../../../domain/transaction/failure-code';
import type { WagerTransactionKind } from '../../../domain/transaction/wager-transaction-kind';
import { WagerTransactionStatus } from '../../../domain/transaction/wager-transaction-status';
import {
  createSubmitTransactionSchema,
  idempotencyKeySchema,
} from '../../../application/dto/schemas';
import { requestContext } from '../../observability/als/request-context';
import { resolveCorrelationId } from '../../observability/als/correlation';
import type { OpportunisticSettlementTrigger } from '../../workers/opportunistic-settlement-trigger';
import { RequiresScope } from '../decorators';
import { SCOPES } from '../../auth/scopes';
import { BusinessRejectionError, NotFoundError } from '../errors';
import { validateWith } from '../pipes/zod-validation.pipe';
import {
  assertProviderIdentity,
  resolveTenantScope,
  type TenantPolicy,
} from '../tenant-scope';

interface AuthenticatedRequest {
  identity?: ProviderIdentity;
  headers: Record<string, string | undefined>;
}

@Controller()
export class WageringController {
  constructor(
    @Inject(SUBMIT_WAGER_TRANSACTION)
    private readonly submit: SubmitWagerTransaction,
    @Inject(GET_TRANSACTION) private readonly getTransaction: GetTransaction,
    @Inject(GET_TRANSACTION_BY_EXTERNAL_ID)
    private readonly getByExternalId: GetTransactionByExternalId,
    @Inject(SUPPORTED_CURRENCIES) private readonly currencies: SupportedCurrencies,
    @Inject(OPPORTUNISTIC_SETTLEMENT_TRIGGER)
    private readonly kicker: OpportunisticSettlementTrigger | null,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private get tenantPolicy(): TenantPolicy {
    return { authEnabled: this.config.env.AUTH_ENABLED };
  }

  @Post('wagering/transactions')
  @RequiresScope(SCOPES.wagerSubmit)
  async submitTransaction(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationHeader: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const parsed = validateWith(createSubmitTransactionSchema(this.currencies), body);
    assertProviderIdentity(this.tenantPolicy, request.identity, parsed.providerId);
    const safeIdempotencyKey =
      idempotencyKey === undefined
        ? undefined
        : validateWith(idempotencyKeySchema, idempotencyKey);

    const correlationId =
      requestContext.get()?.correlationId ??
      resolveCorrelationId(correlationHeader);

    const result = await this.submit.execute({
      providerId: parsed.providerId,
      externalTransactionId: parsed.externalTransactionId,
      playerId: parsed.playerId,
      walletId: parsed.walletId,
      roundId: parsed.roundId,
      gameId: parsed.gameId,
      kind: parsed.kind as WagerTransactionKind,
      money: parsed.money,
      referenceExternalTransactionId: parsed.referenceExternalTransactionId,
      idempotencyKey: safeIdempotencyKey,
      channel: 'http',
      correlationId,
      causationId: correlationId,
    });

    if (result.settled && this.kicker) {
      void this.kicker
        .kick(result.settled.providerId, result.settled.externalTransactionId)
        .catch(() => undefined);
    }

    const payload = {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
      failureCode: result.failureCode,
      idempotentReplay: result.idempotentReplay,
    };

    if (result.status === WagerTransactionStatus.Rejected) {
      // `status` (HTTP) e `transactionStatus` (domínio) coexistem no corpo 422 para
      // manter o replay idêntico sem colidir com o campo `status` do RFC 9457.
      throw new BusinessRejectionError(
        result.failureCode ?? FailureCode.ValidationFailed,
        `transação rejeitada: ${result.failureCode}`,
        {
          transactionId: result.transactionId,
          transactionStatus: result.status,
          balance: result.balance,
          failureCode: result.failureCode,
          idempotentReplay: result.idempotentReplay,
        },
      );
    }

    reply
      .status(
        result.status === WagerTransactionStatus.PendingReference ? 202 : 201,
      )
      .header('content-type', 'application/json');
    return payload;
  }

  @Get('wagering/transactions/:transactionId')
  @RequiresScope(SCOPES.walletRead)
  async getTransactionById(
    @Param('transactionId') transactionId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const transaction = await this.getTransaction.execute(
      transactionId,
      resolveTenantScope(this.tenantPolicy, request.identity),
    );
    if (!transaction) {
      throw new NotFoundError(
        'TRANSACTION_NOT_FOUND',
        `transação ${transactionId} não encontrada`,
      );
    }
    return { ...transaction };
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @RequiresScope(SCOPES.walletRead)
  async getTransactionByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    assertProviderIdentity(this.tenantPolicy, request.identity, providerId);
    const transaction = await this.getByExternalId.execute(
      providerId,
      externalTransactionId,
    );
    if (!transaction) {
      throw new NotFoundError(
        'TRANSACTION_NOT_FOUND',
        `transação ${providerId}:${externalTransactionId} não encontrada`,
      );
    }
    return { ...transaction };
  }
}
