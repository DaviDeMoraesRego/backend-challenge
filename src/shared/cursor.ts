/** Cursor opaco e estável do ledger: base64url de `{ v: walletVersion, i: entryId }`. */
export interface LedgerCursor {
  readonly walletVersion: number;
  readonly entryId: string;
}

export class InvalidCursorError extends Error {
  constructor(message = 'cursor inválido') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: LedgerCursor): string {
  const payload = JSON.stringify({ v: cursor.walletVersion, i: cursor.entryId });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): LedgerCursor {
  if (!raw || typeof raw !== 'string') throw new InvalidCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('cursor não é base64url de JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new InvalidCursorError();
  const { v, i } = parsed as { v?: unknown; i?: unknown };
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new InvalidCursorError('cursor.walletVersion inválido');
  }
  if (typeof i !== 'string' || !UUID_PATTERN.test(i)) {
    throw new InvalidCursorError('cursor.entryId inválido');
  }
  return { walletVersion: v, entryId: i };
}
