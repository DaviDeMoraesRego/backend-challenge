/**
 * SQLSTATEs tratados como transitórios (plans/04 §8.6).
 * `23505`/`23514` NÃO entram: são bug/invariante violada → falha ruidosa.
 */
export const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set([
  '40001',
  '40P01',
  '55P03',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '57P01',
]);

const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

export function extractSqlState(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      code?: unknown;
      sqlState?: unknown;
      errno?: unknown;
      cause?: unknown;
      driverError?: unknown;
      originalError?: unknown;
    };
    for (const value of [candidate.code, candidate.sqlState, candidate.errno]) {
      if (typeof value === 'string' && SQLSTATE_PATTERN.test(value)) return value;
    }
    current =
      candidate.cause ?? candidate.driverError ?? candidate.originalError ?? null;
  }
  return null;
}

export function isTransientSqlState(sqlstate: string | null): boolean {
  return sqlstate !== null && TRANSIENT_SQLSTATES.has(sqlstate);
}

export function isLockConflict(sqlstate: string | null): boolean {
  return sqlstate === '55P03' || sqlstate === '40P01' || sqlstate === '40001';
}
