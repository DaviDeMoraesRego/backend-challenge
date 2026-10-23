import { Migration } from '@mikro-orm/migrations';

/**
 * Tenancy de wallet: cada wallet pertence a no máximo um provedor.
 * `NULL` = wallet de backoffice (aberta por `ops-admin`); a primeira operação de
 * um provedor a adota (UPDATE condicional, ver wallet.repository.claimProvider).
 */
const ADD_COLUMN = `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS provider_id TEXT NULL`;

const BACKFILL = `UPDATE wallets w
   SET provider_id = t.provider_id
  FROM (
    SELECT DISTINCT ON (wallet_id) wallet_id, provider_id
      FROM wager_transactions
     WHERE wallet_id IS NOT NULL AND provider_id <> 'system'
     ORDER BY wallet_id, created_at ASC, id ASC
  ) t
 WHERE w.id = t.wallet_id AND w.provider_id IS NULL`;

const INDEX = `CREATE INDEX IF NOT EXISTS ix_wallets_provider
  ON wallets (provider_id) WHERE provider_id IS NOT NULL`;

export class Migration20260101000004_wallet_provider_ownership extends Migration {
  override async up(): Promise<void> {
    this.addSql(ADD_COLUMN);
    this.addSql(BACKFILL);
    this.addSql(INDEX);
  }

  override async down(): Promise<void> {
    this.addSql('DROP INDEX IF EXISTS ix_wallets_provider');
    this.addSql('ALTER TABLE wallets DROP COLUMN IF EXISTS provider_id');
  }
}
