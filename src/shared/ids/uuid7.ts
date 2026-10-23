/**
 * UUIDv7 gerado na aplicação (ADR-08/plans/03): B-tree com localidade temporal
 * sem sequence de negócio compartilhada (nenhum hot row).
 */
let lastMs = -1;
let sequence = 0;

const HEX: string[] = Array.from({ length: 256 }, (_, index) =>
  index.toString(16).padStart(2, '0'),
);

export function uuidv7(now: number = Date.now()): string {
  if (now === lastMs) {
    sequence = (sequence + 1) & 0x0fff;
  } else {
    lastMs = now;
    sequence = Math.floor(Math.random() * 0x1000);
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);

  let timestamp = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }

  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => HEX[byte]).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
