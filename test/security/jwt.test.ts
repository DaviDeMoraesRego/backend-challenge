import { describe, expect, it } from 'bun:test';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
} from 'jose';
import {
  TokenExpiredError,
  TokenInvalidError,
} from '../../src/contexts/wagering/application/ports/provider-identity';
import { JoseProviderIdentityAdapter } from '../../src/contexts/wagering/infrastructure/auth/jose-provider-identity';
import { parseScopes } from '../../src/contexts/wagering/infrastructure/auth/scopes';

const ISSUER = 'http://localhost:8080/realms/jungle';
const AUDIENCE = 'wagering-api';

interface KeyPairFixture {
  readonly privateKey: CryptoKey;
  readonly jwk: JWK;
}

async function makeKey(kid: string): Promise<KeyPairFixture> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  return {
    privateKey: privateKey as unknown as CryptoKey,
    jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' },
  };
}

function adapterFor(keys: KeyPairFixture[]): JoseProviderIdentityAdapter {
  const localJwks = createLocalJWKSet({ keys: keys.map((key) => key.jwk) });
  return new JoseProviderIdentityAdapter({
    jwksUrl: 'http://unused.local/certs',
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: localJwks,
  });
}

interface TokenOptions {
  readonly key: KeyPairFixture;
  readonly kid?: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly expiresIn?: string | number;
  readonly providerId?: string;
  readonly scope?: string;
}

async function signToken(options: TokenOptions): Promise<string> {
  return new SignJWT({
    provider_id: options.providerId ?? 'provider-a',
    scope: options.scope ?? 'wager:submit wallet:read',
  })
    .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? String(options.key.jwk.kid) })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setSubject('service-account-provider-a')
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
    .sign(options.key.privateKey);
}

describe('Segurança — JWT/JWKS (SEC-07/SEC-08)', () => {
  it('token válido produz identidade com provider_id e escopos', async () => {
    const key = await makeKey('k1');
    const adapter = adapterFor([key]);
    const identity = await adapter.authenticate(
      await signToken({ key, providerId: 'provider-b', scope: 'wager:submit wallet:read' }),
    );
    expect(identity.providerId).toBe('provider-b');
    expect(identity.subject).toBe('service-account-provider-a');
    expect(identity.scopes.has('wager:submit')).toBe(true);
    expect(identity.scopes.has('wallet:read')).toBe(true);
    expect(identity.scopes.has('wallet:admin')).toBe(false);
  });

  it('token expirado lança TokenExpiredError', async () => {
    const key = await makeKey('k1');
    const adapter = adapterFor([key]);
    const expired = await signToken({ key, expiresIn: Math.floor(Date.now() / 1000) - 60 });
    await expect(adapter.authenticate(expired)).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it('audience, issuer e assinatura inválidos lançam TokenInvalidError', async () => {
    const key = await makeKey('k1');
    const adapter = adapterFor([key]);

    await expect(
      adapter.authenticate(await signToken({ key, audience: 'outra-api' })),
    ).rejects.toBeInstanceOf(TokenInvalidError);

    await expect(
      adapter.authenticate(await signToken({ key, issuer: 'http://evil/realms/jungle' })),
    ).rejects.toBeInstanceOf(TokenInvalidError);

    const foreignKey = await makeKey('k1');
    await expect(
      adapter.authenticate(await signToken({ key: foreignKey })),
    ).rejects.toBeInstanceOf(TokenInvalidError);

    await expect(adapter.authenticate('nao-e-um-jwt')).rejects.toBeInstanceOf(
      TokenInvalidError,
    );
  });

  it('SEC-08: kid desconhecido (rotação) é rejeitado pelo JWKS atual e aceito após rotação', async () => {
    const oldKey = await makeKey('k1');
    const newKey = await makeKey('k2');

    const beforeRotation = adapterFor([oldKey]);
    const rotatedToken = await signToken({ key: newKey, kid: 'k2' });
    await expect(beforeRotation.authenticate(rotatedToken)).rejects.toBeInstanceOf(
      TokenInvalidError,
    );

    // após a rotação, o JWKS passa a conter a nova chave
    const afterRotation = adapterFor([oldKey, newKey]);
    const identity = await afterRotation.authenticate(rotatedToken);
    expect(identity.providerId).toBe('provider-a');
  });

  it('parseScopes usa apenas claims de scope; roles de realm não elevam privilégio', () => {
    expect([...parseScopes({ scope: 'wallet:read wallet:admin' })]).toEqual([
      'wallet:read',
      'wallet:admin',
    ]);
    expect([...parseScopes({ scopes: ['reconcile:run'] })]).toEqual(['reconcile:run']);
    // hardening: `realm_access.roles` é outro plano de autorização e não vira scope
    expect([
      ...parseScopes({ realm_access: { roles: ['wager:submit'] } }),
    ]).toEqual([]);
    expect(parseScopes({}).size).toBe(0);
  });
});
