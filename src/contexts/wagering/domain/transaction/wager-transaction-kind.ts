export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export const ALL_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Opening,
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

/** OPENING é interno: nunca pode ser submetido por HTTP nem pela fila. */
export const EXTERNAL_KINDS: readonly WagerTransactionKind[] = ALL_KINDS.filter(
  (kind) => kind !== WagerTransactionKind.Opening,
);

export function isExternalKind(kind: WagerTransactionKind): boolean {
  return kind !== WagerTransactionKind.Opening;
}

/** REFUND e ROLLBACK exigem referência (README §7 regra 1). */
export function requiresReference(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
}

/** LOSS registra resultado sem mover saldo. */
export function affectsBalance(kind: WagerTransactionKind): boolean {
  return kind !== WagerTransactionKind.Loss;
}

export function isKnownKind(value: string): value is WagerTransactionKind {
  return (ALL_KINDS as readonly string[]).includes(value);
}
