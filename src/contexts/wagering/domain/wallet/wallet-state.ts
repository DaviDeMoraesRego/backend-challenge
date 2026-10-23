import { Money } from '../money/money';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  /** provedor dono da wallet; `null` para wallets abertas pelo backoffice. */
  readonly providerId: string | null;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
