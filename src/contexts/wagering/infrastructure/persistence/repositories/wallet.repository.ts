import type { DbSession } from '../../../application/ports/db-session';
import type { WalletRepository } from '../../../application/ports/repositories';
import type { Wallet } from '../../../domain/wallet/wallet';
import { toWallet } from '../mappers';
import type { WalletRow } from '../records';

export class MikroWalletRepository implements WalletRepository {
  constructor(private readonly session: DbSession) {}

  async insert(wallet: Wallet): Promise<void> {
    await this.session.query(
      `INSERT INTO wallets (id, player_id, provider_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        wallet.id,
        wallet.playerId,
        wallet.providerId,
        wallet.currency,
        wallet.balance.toString(),
        wallet.version,
        wallet.createdAt,
        wallet.updatedAt,
      ],
    );
  }

  /** Unidade de concorrência do sistema: lock pessimista por linha de wallet. */
  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const row = await this.session.queryOne<WalletRow>(
      `SELECT * FROM wallets WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return row ? toWallet(row) : null;
  }

  async findById(id: string): Promise<Wallet | null> {
    const row = await this.session.queryOne<WalletRow>(
      `SELECT * FROM wallets WHERE id = $1`,
      [id],
    );
    return row ? toWallet(row) : null;
  }

  async exists(id: string): Promise<boolean> {
    const row = await this.session.queryOne<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM wallets WHERE id = $1) AS exists`,
      [id],
    );
    return row?.exists === true;
  }

  /**
   * Vincula o provedor na primeira operação. O `WHERE provider_id IS NULL`
   * garante que apenas um provedor consegue "adotar" a wallet.
   */
  async claimProvider(id: string, providerId: string): Promise<boolean> {
    const rows = await this.session.query<{ id: string }>(
      `UPDATE wallets
          SET provider_id = $2, updated_at = now()
        WHERE id = $1 AND provider_id IS NULL
        RETURNING id`,
      [id, providerId],
    );
    return rows.length > 0;
  }

  /** Guarda otimista: a versão lida precisa ser imediatamente anterior à escrita. */
  async applyBalance(wallet: Wallet): Promise<void> {
    const rows = await this.session.query<{ id: string }>(
      `UPDATE wallets
          SET balance = $2, version = $3, updated_at = $4
        WHERE id = $1 AND version = $5
        RETURNING id`,
      [
        wallet.id,
        wallet.balance.toString(),
        wallet.version,
        wallet.updatedAt,
        wallet.version - 1,
      ],
    );
    if (rows.length === 0) {
      throw new Error(
        `wallet ${wallet.id} sofreu escrita concorrente (versão ${wallet.version - 1} não confere)`,
      );
    }
  }

  async pageAfter(cursorId: string | null, limit: number): Promise<Wallet[]> {
    const rows = cursorId
      ? await this.session.query<WalletRow>(
          `SELECT * FROM wallets WHERE id > $1 ORDER BY id LIMIT $2`,
          [cursorId, limit],
        )
      : await this.session.query<WalletRow>(
          `SELECT * FROM wallets ORDER BY id LIMIT $1`,
          [limit],
        );
    return rows.map(toWallet);
  }
}
