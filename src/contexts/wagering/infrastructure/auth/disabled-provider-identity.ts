import type {
  ProviderIdentity,
  ProviderIdentityPort,
} from '../../application/ports/provider-identity';
import { SCOPES } from './scopes';

/**
 * Ponto de extensão explícito quando `AUTH_ENABLED=false` (README §2 aceita não
 * implementar auth, desde que o desenho permaneça no código).
 */
export class DisabledProviderIdentity implements ProviderIdentityPort {
  async authenticate(): Promise<ProviderIdentity> {
    return {
      subject: 'anonymous',
      providerId: undefined,
      scopes: new Set<string>(Object.values(SCOPES)),
    };
  }
}
