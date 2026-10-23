export const SCOPES = {
  wagerSubmit: 'wager:submit',
  walletRead: 'wallet:read',
  walletAdmin: 'wallet:admin',
  reconcileRun: 'reconcile:run',
} as const;

export type ScopeName = (typeof SCOPES)[keyof typeof SCOPES];

/**
 * Extrai escopos **apenas** dos claims de scope (`scope` / `scopes`).
 * `realm_access.roles` deliberadamente NÃO é considerado: misturar planos de
 * autorização permitiria que uma role de realm colidisse com um scope de API.
 */
export function parseScopes(payload: Record<string, unknown>): ReadonlySet<string> {
  const scopes = new Set<string>();
  const scopeClaim = payload.scope;
  if (typeof scopeClaim === 'string') {
    for (const item of scopeClaim.split(' ')) {
      if (item) scopes.add(item);
    }
  }
  const scopesClaim = payload.scopes;
  if (Array.isArray(scopesClaim)) {
    for (const item of scopesClaim) {
      if (typeof item === 'string') scopes.add(item);
    }
  }
  return scopes;
}
