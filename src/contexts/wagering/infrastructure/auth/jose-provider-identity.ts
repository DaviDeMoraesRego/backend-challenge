import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import {
  TokenExpiredError,
  TokenInvalidError,
  type ProviderIdentity,
  type ProviderIdentityPort,
} from '../../application/ports/provider-identity';
import { parseScopes } from './scopes';

export interface JoseIdentityOptions {
  readonly jwksUrl: string;
  readonly issuer: string;
  readonly audience: string;
  /** algoritmos aceitos — nunca deixar o header `alg` do token escolher. */
  readonly algorithms?: readonly string[];
  readonly clockToleranceSeconds?: number;
  /** permite injetar um JWKS local nos testes de unidade (SEC-07/08). */
  readonly jwks?: JWTVerifyGetKey;
}

/** Validação de JWT contra o JWKS do Keycloak, com cache e rotação de chaves. */
export class JoseProviderIdentityAdapter implements ProviderIdentityPort {
  private readonly jwks: JWTVerifyGetKey;

  constructor(private readonly options: JoseIdentityOptions) {
    this.jwks =
      options.jwks ??
      createRemoteJWKSet(new URL(options.jwksUrl), {
        cacheMaxAge: 600_000,
        cooldownDuration: 30_000,
      });
  }

  async authenticate(token: string): Promise<ProviderIdentity> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: [...(this.options.algorithms ?? ['RS256'])],
        clockTolerance: this.options.clockToleranceSeconds ?? 5,
      });
      const providerId =
        typeof payload.provider_id === 'string' ? payload.provider_id : undefined;
      return {
        subject: String(payload.sub ?? ''),
        providerId,
        scopes: parseScopes(payload as Record<string, unknown>),
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ERR_JWT_EXPIRED') {
        throw new TokenExpiredError();
      }
      throw new TokenInvalidError(
        error instanceof Error ? error.message : 'falha ao validar token',
      );
    }
  }
}
