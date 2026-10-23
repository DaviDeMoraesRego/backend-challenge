/** Detecta violação de unicidade sem vazar detalhes do driver para o domínio. */
export function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      code?: unknown;
      cause?: unknown;
      driverError?: unknown;
      originalError?: unknown;
    };
    if (candidate.code === '23505') return true;
    current =
      candidate.cause ?? candidate.driverError ?? candidate.originalError ?? null;
  }
  return false;
}
