export type AccountCode = 'PROVIDER_CLEARING' | 'OPENING_EQUITY';

/**
 * Referência de conta de contrapartida — nunca tem saldo materializado
 * (zero hot row, plans/04 §8.4).
 */
export interface AccountRef {
  readonly code: AccountCode;
  readonly owner: string;
  readonly currency: string;
}

export const SYSTEM_OWNER = 'system';

export function providerClearingAccount(providerId: string, currency: string): AccountRef {
  return { code: 'PROVIDER_CLEARING', owner: providerId, currency };
}

export function openingEquityAccount(currency: string): AccountRef {
  return { code: 'OPENING_EQUITY', owner: SYSTEM_OWNER, currency };
}

export function accountRefKey(ref: AccountRef): string {
  return `${ref.code}:${ref.owner}:${ref.currency}`;
}
