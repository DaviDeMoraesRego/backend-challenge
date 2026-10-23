export interface ProviderIdentity {
  readonly subject: string;
  /** claim `provider_id` — ausente para clients de operação (ops-admin). */
  readonly providerId?: string;
  readonly scopes: ReadonlySet<string>;
}

export class TokenInvalidError extends Error {
  constructor(message = 'token inválido') {
    super(message);
    this.name = 'TokenInvalidError';
  }
}

export class TokenExpiredError extends Error {
  constructor(message = 'token expirado') {
    super(message);
    this.name = 'TokenExpiredError';
  }
}

export interface ProviderIdentityPort {
  authenticate(token: string): Promise<ProviderIdentity>;
}
