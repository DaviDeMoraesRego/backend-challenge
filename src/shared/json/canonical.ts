import { createHash } from 'node:crypto';

export type CanonicalInput =
  | null
  | boolean
  | string
  | number
  | CanonicalInput[]
  | { readonly [key: string]: CanonicalInput | undefined };

/**
 * JSON canônico (ADR-04): chaves ordenadas recursivamente, sem espaços, UTF-8.
 * Usado para o `payloadHash` — o valor precisa ser estável entre processos.
 */
export function canonicalize(value: CanonicalInput): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonicalize: apenas números finitos são serializáveis');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const body = entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item as CanonicalInput)}`)
    .join(',');
  return `{${body}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function canonicalSha256(value: CanonicalInput): string {
  return sha256Hex(canonicalize(value));
}
