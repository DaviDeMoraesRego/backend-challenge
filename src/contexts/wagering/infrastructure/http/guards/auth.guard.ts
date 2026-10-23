import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AppConfig } from '../../../../../config/env';
import { CONFIG, PROVIDER_IDENTITY } from '../../../../../config/tokens';
import type { ProviderIdentityPort } from '../../../application/ports/provider-identity';
import {
  TokenExpiredError,
  TokenInvalidError,
} from '../../../application/ports/provider-identity';
import { ForbiddenError, UnauthorizedError } from '../errors';
import { PUBLIC_ROUTE, REQUIRED_SCOPES } from '../decorators';

/**
 * Guard global (ADR-09): JWT via JWKS + escopo por rota + `@Public()` para
 * health/metrics. Sem providers request-scoped — a identidade vai no request.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PROVIDER_IDENTITY) private readonly identities: ProviderIdentityPort,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.config.env.AUTH_ENABLED) return true;

    const handler = context.getHandler();
    const controller = context.getClass();
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      handler,
      controller,
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      identity?: unknown;
    }>();
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedError('TOKEN_INVALID', 'token ausente');
    }

    let identity;
    try {
      identity = await this.identities.authenticate(header.slice('Bearer '.length));
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        throw new UnauthorizedError('TOKEN_EXPIRED', error.message);
      }
      if (error instanceof TokenInvalidError) {
        throw new UnauthorizedError('TOKEN_INVALID', error.message);
      }
      throw error;
    }
    request.identity = identity;

    const required =
      this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPES, [
        handler,
        controller,
      ]) ?? [];
    for (const scope of required) {
      if (!identity.scopes.has(scope)) {
        throw new ForbiddenError(
          'INSUFFICIENT_SCOPE',
          `escopo requerido: ${scope}`,
          scope,
        );
      }
    }
    return true;
  }
}
