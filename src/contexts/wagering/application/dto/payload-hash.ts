import { canonicalSha256 } from '../../../../shared/json/canonical';
import { Money } from '../../domain/money/money';

export interface WagerBusinessPayload {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string | null;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: { readonly amount: string; readonly currency: string };
  readonly referenceExternalTransactionId?: string | null;
}

/**
 * ADR-04: SHA-256 de JSON canônico do subconjunto de negócio.
 * `amount` é normalizado (`"25"` e `"25.00"` colidem); header e metadados de
 * transporte ficam fora do hash.
 */
export function computeWagerPayloadHash(payload: WagerBusinessPayload): string {
  const normalized = Money.from({
    amount: payload.money.amount,
    currency: payload.money.currency,
  });
  return canonicalSha256({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: normalized.toString(), currency: normalized.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId ?? null,
  });
}

export function computeOpeningPayloadHash(input: {
  walletId: string;
  playerId: string;
  amount: string;
  currency: string;
}): string {
  return canonicalSha256({
    kind: 'OPENING',
    walletId: input.walletId,
    playerId: input.playerId,
    amount: Money.of(input.amount, input.currency).toString(),
    currency: input.currency,
  });
}
