import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  CONFIG,
  GET_WALLET,
  LIST_WALLET_LEDGER,
  OPEN_WALLET,
  RECONCILE_WALLET,
  SUPPORTED_CURRENCIES,
} from '../../../../../config/tokens';
import type { AppConfig } from '../../../../../config/env';
import type { OpenWallet } from '../../../application/use-cases/open-wallet';
import type {
  GetWallet,
  ListWalletLedger,
} from '../../../application/use-cases/queries';
import type { ReconcileWallet } from '../../../application/use-cases/reconcile-wallet';
import type { SupportedCurrencies } from '../../../domain/money/currency';
import {
  createOpenWalletSchema,
  ledgerQuerySchema,
  type LedgerQuery,
} from '../../../application/dto/schemas';
import { requestContext } from '../../observability/als/request-context';
import { resolveCorrelationId } from '../../observability/als/correlation';
import { RequiresScope } from '../decorators';
import { SCOPES } from '../../auth/scopes';
import type { ProviderIdentity } from '../../../application/ports/provider-identity';
import { NotFoundError } from '../errors';
import { validateWith } from '../pipes/zod-validation.pipe';
import { resolveTenantScope, type TenantPolicy } from '../tenant-scope';

interface AuthenticatedRequest {
  identity?: ProviderIdentity;
}

@Controller('wallets')
export class WalletController {
  constructor(
    @Inject(OPEN_WALLET) private readonly openWallet: OpenWallet,
    @Inject(GET_WALLET) private readonly getWallet: GetWallet,
    @Inject(LIST_WALLET_LEDGER) private readonly listLedger: ListWalletLedger,
    @Inject(RECONCILE_WALLET) private readonly reconcileWallet: ReconcileWallet,
    @Inject(SUPPORTED_CURRENCIES) private readonly currencies: SupportedCurrencies,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private get tenantPolicy(): TenantPolicy {
    return { authEnabled: this.config.env.AUTH_ENABLED };
  }

  @Post()
  @RequiresScope(SCOPES.walletAdmin)
  async create(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationHeader: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const parsed = validateWith(createOpenWalletSchema(this.currencies), body);
    const correlationId =
      requestContext.get()?.correlationId ??
      resolveCorrelationId(correlationHeader);

    const result = await this.openWallet.execute({
      playerId: parsed.playerId,
      initialBalance: parsed.initialBalance,
      correlationId,
      // wallet:admin é de backoffice; se o token tiver provider_id, a wallet nasce dele
      providerId: request.identity?.providerId ?? null,
    });

    reply.status(201);
    return {
      id: result.id,
      playerId: result.playerId,
      balance: result.balance,
      version: result.version,
    };
  }

  @Get(':walletId')
  @RequiresScope(SCOPES.walletRead)
  async getById(
    @Param('walletId') walletId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const wallet = await this.getWallet.execute(
      walletId,
      resolveTenantScope(this.tenantPolicy, request.identity),
    );
    if (!wallet) {
      throw new NotFoundError('WALLET_NOT_FOUND', `wallet ${walletId} não encontrada`);
    }
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  @Get(':walletId/ledger')
  @RequiresScope(SCOPES.walletRead)
  async ledger(
    @Param('walletId') walletId: string,
    @Query() query: LedgerQuery,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const parsed = validateWith(ledgerQuerySchema, query);
    const page = await this.listLedger.execute(
      walletId,
      { cursor: parsed.cursor, limit: parsed.limit },
      resolveTenantScope(this.tenantPolicy, request.identity),
    );
    if (!page) {
      throw new NotFoundError('WALLET_NOT_FOUND', `wallet ${walletId} não encontrada`);
    }
    return { entries: page.entries, nextCursor: page.nextCursor };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  @RequiresScope(SCOPES.reconcileRun)
  async reconcile(
    @Param('walletId') walletId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const result = await this.reconcileWallet.execute(
      walletId,
      'endpoint',
      resolveTenantScope(this.tenantPolicy, request.identity),
    );
    if (!result) {
      throw new NotFoundError('WALLET_NOT_FOUND', `wallet ${walletId} não encontrada`);
    }
    return {
      walletId: result.walletId,
      storedBalance: result.storedBalance,
      calculatedBalance: result.calculatedBalance,
      difference: result.difference,
      consistent: result.consistent,
      checkedEntries: result.checkedEntries,
    };
  }
}
