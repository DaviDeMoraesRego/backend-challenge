import { describe, expect, it } from 'bun:test';
import {
  assertProviderIdentity,
  resolveTenantScope,
  type TenantPolicy,
} from '../../src/contexts/wagering/infrastructure/http/tenant-scope';
import { ForbiddenError } from '../../src/contexts/wagering/infrastructure/http/errors';

const policyWith = (authEnabled: boolean): TenantPolicy => ({ authEnabled });

const identity = (providerId: string | undefined, scopes: string[]) => ({
  subject: 'service-account',
  providerId,
  scopes: new Set(scopes),
});

describe('Segurança — tenancy por provedor', () => {
  it('provedor enxerga apenas o próprio escopo', () => {
    expect(resolveTenantScope(policyWith(true), identity('provider-a', ['wallet:read']))).toBe(
      'provider-a',
    );
  });

  it('backoffice (wallet:admin) não é filtrado por provedor', () => {
    expect(resolveTenantScope(policyWith(true), identity(undefined, ['wallet:admin']))).toBeNull();
    expect(
      resolveTenantScope(policyWith(true), identity(undefined, ['reconcile:run'])),
    ).toBeNull();
  });

  it('token sem provider_id e sem scope de backoffice é rejeitado', () => {
    expect(() =>
      resolveTenantScope(policyWith(true), identity(undefined, ['wallet:read'])),
    ).toThrow(ForbiddenError);
  });

  it('impersonação de outro provedor é bloqueada', () => {
    expect(() =>
      assertProviderIdentity(
        policyWith(true),
        identity('provider-a', ['wager:submit']),
        'provider-b',
      ),
    ).toThrow(ForbiddenError);
  });

  it('token sem provider_id não pode submeter transações', () => {
    expect(() =>
      assertProviderIdentity(
        policyWith(true),
        identity(undefined, ['wager:submit']),
        'provider-a',
      ),
    ).toThrow(ForbiddenError);
  });

  it('sem auth (dev/test) o filtro é desligado', () => {
    expect(resolveTenantScope(policyWith(false), undefined)).toBeNull();
    expect(() => assertProviderIdentity(policyWith(false), undefined, 'provider-a')).not.toThrow();
  });
});
