import type { ProviderIdentity } from '../../application/ports/provider-identity';
import { SCOPES } from '../auth/scopes';
import { ForbiddenError } from './errors';

/**
 * Política mínima que a borda HTTP precisa. Desacoplada do `AppConfig` completo:
 * o adaptador HTTP não deve depender do tipo de composição global.
 */
export interface TenantPolicy {
  readonly authEnabled: boolean;
}

/** Scopes de backoffice: enxergam qualquer tenant (sem filtro de provedor). */
const BACKOFFICE_SCOPES: readonly string[] = [SCOPES.walletAdmin, SCOPES.reconcileRun];

/**
 * Resolve o filtro de tenancy para leituras.
 * Devolve `null` para backoffice e o `providerId` do token para provedores.
 * Sem claim `provider_id` e sem scope de backoffice ⇒ 403 (nunca acesso amplo).
 */
export function resolveTenantScope(
  policy: TenantPolicy,
  identity?: ProviderIdentity,
): string | null {
  if (!policy.authEnabled) return null;

  const scopes = identity?.scopes ?? new Set<string>();
  if (BACKOFFICE_SCOPES.some((scope) => scopes.has(scope))) return null;

  if (!identity?.providerId) {
    throw new ForbiddenError(
      'PROVIDER_REQUIRED',
      'token sem claim provider_id para acesso a dados de tenant',
    );
  }
  return identity.providerId;
}

/** Garante que o token só opera em nome do próprio provedor. */
export function assertProviderIdentity(
  policy: TenantPolicy,
  identity: ProviderIdentity | undefined,
  providerId: string,
): void {
  if (!policy.authEnabled) return;

  if (!identity?.providerId) {
    throw new ForbiddenError(
      'PROVIDER_REQUIRED',
      'token sem claim provider_id — impersonação bloqueada',
    );
  }
  if (identity.providerId !== providerId) {
    throw new ForbiddenError(
      'PROVIDER_MISMATCH',
      'claim provider_id difere do providerId solicitado',
    );
  }
}
