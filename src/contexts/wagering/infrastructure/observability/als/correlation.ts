import { uuidv7 } from '../../../../../shared/ids/uuid7';

const CORRELATION_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** Sanitiza `x-correlation-id` (evita log injection) ou gera um novo UUIDv7. */
export function resolveCorrelationId(raw: string | undefined | null): string {
  if (typeof raw === 'string' && CORRELATION_PATTERN.test(raw)) return raw;
  return uuidv7();
}
