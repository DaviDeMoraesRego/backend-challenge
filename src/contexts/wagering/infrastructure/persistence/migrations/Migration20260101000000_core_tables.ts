import { Migration } from '@mikro-orm/migrations';

const DOMAINS: readonly string[] = [
  `DO $$ BEGIN CREATE DOMAIN money_amount AS NUMERIC(19,2);
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN CREATE DOMAIN currency_code AS CHAR(3) CHECK (VALUE ~ '^[A-Z]{3}$');
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN CREATE DOMAIN failure_code AS TEXT CHECK (VALUE ~ '^[A-Z][A-Z0-9_]{2,40}$');
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN CREATE DOMAIN tx_kind AS TEXT
     CHECK (VALUE IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK'));
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN CREATE DOMAIN tx_status AS TEXT
     CHECK (VALUE IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'));
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN CREATE DOMAIN leg_direction AS TEXT CHECK (VALUE IN ('DEBIT','CREDIT'));
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
];

const TABLES: readonly string[] = [
  `CREATE TABLE wallets (
     id          UUID PRIMARY KEY,
     player_id   UUID NOT NULL,
     currency    currency_code NOT NULL,
     balance     money_amount  NOT NULL DEFAULT 0 CHECK (balance >= 0),
     version     BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
   )`,
  `CREATE TABLE accounts (
     id          UUID PRIMARY KEY,
     code        TEXT NOT NULL CHECK (code IN ('PROVIDER_CLEARING','OPENING_EQUITY')),
     owner       TEXT NOT NULL,
     currency    currency_code NOT NULL,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT uq_accounts UNIQUE (code, owner, currency)
   )`,
  `CREATE TABLE wager_transactions (
     id                UUID PRIMARY KEY,
     provider_id       TEXT NOT NULL,
     external_transaction_id TEXT NOT NULL,
     idempotency_key   TEXT NOT NULL,
     payload_hash      TEXT NOT NULL,
     wallet_id         UUID NULL REFERENCES wallets (id),
     player_id         UUID NOT NULL,
     currency          currency_code NOT NULL,
     round_id          TEXT NOT NULL,
     game_id           TEXT NOT NULL,
     kind              tx_kind NOT NULL,
     amount            money_amount NOT NULL
                       CHECK (amount > 0 OR (kind = 'OPENING' AND amount >= 0)),
     status            tx_status NOT NULL DEFAULT 'PENDING',
     reference_external_transaction_id TEXT NULL,
     reference_transaction_id          UUID NULL REFERENCES wager_transactions (id),
     failure_code      failure_code NULL,
     resulting_balance_amount   money_amount NULL,
     processed_at      TIMESTAMPTZ NULL,
     attempts          INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
     next_attempt_at   TIMESTAMPTZ NULL,
     created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT uq_wtx_idempotency_key UNIQUE (idempotency_key),
     CONSTRAINT uq_wtx_provider_external UNIQUE (provider_id, external_transaction_id),
     CONSTRAINT ck_wtx_terminal_snapshot CHECK (
       status IN ('PROCESSED','REJECTED','PENDING_REFERENCE')
         OR resulting_balance_amount IS NULL
     ),
     CONSTRAINT ck_wtx_reference_kind CHECK (
       kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL
       OR status IN ('REJECTED','PENDING')
     )
   )`,
  `CREATE TABLE journals (
     id             UUID PRIMARY KEY,
     transaction_id UUID NOT NULL REFERENCES wager_transactions (id),
     currency       currency_code NOT NULL,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT uq_journals_transaction UNIQUE (transaction_id)
   )`,
  `CREATE TABLE ledger_entries (
     id             UUID PRIMARY KEY,
     journal_id     UUID NOT NULL REFERENCES journals (id),
     transaction_id UUID NOT NULL REFERENCES wager_transactions (id),
     wallet_id      UUID NULL REFERENCES wallets (id),
     account_id     UUID NULL REFERENCES accounts (id),
     direction      leg_direction NOT NULL,
     amount         money_amount NOT NULL CHECK (amount > 0),
     currency       currency_code NOT NULL,
     balance_before money_amount NULL,
     balance_after  money_amount NULL,
     wallet_version BIGINT NULL,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT ck_leg_exactly_one_side CHECK (
       (wallet_id IS NOT NULL)::int + (account_id IS NOT NULL)::int = 1
     ),
     CONSTRAINT ck_leg_wallet_fields CHECK (
       (wallet_id IS NOT NULL AND balance_before IS NOT NULL AND balance_after IS NOT NULL
          AND wallet_version IS NOT NULL AND account_id IS NULL)
       OR
       (account_id IS NOT NULL AND balance_before IS NULL AND balance_after IS NULL
          AND wallet_version IS NULL AND wallet_id IS NULL)
     ),
     CONSTRAINT ck_leg_wallet_arithmetic CHECK (
       wallet_id IS NULL OR
       (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
       (direction = 'DEBIT'  AND balance_after = balance_before - amount)
     )
   )`,
  `CREATE TABLE inbox_messages (
     consumer_name TEXT NOT NULL,
     message_id    TEXT NOT NULL,
     payload_hash  TEXT NOT NULL,
     received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     processed_at  TIMESTAMPTZ NULL,
     PRIMARY KEY (consumer_name, message_id)
   )`,
  `CREATE TABLE outbox_messages (
     id             UUID PRIMARY KEY,
     aggregate_id   UUID NOT NULL,
     event_type     TEXT NOT NULL,
     payload        JSONB NOT NULL,
     trace_context  JSONB NULL,
     occurred_at    TIMESTAMPTZ NOT NULL,
     attempts       INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     published_at   TIMESTAMPTZ NULL,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

const INDEXES: readonly string[] = [
  `CREATE UNIQUE INDEX uq_wtx_reversal_once
     ON wager_transactions (provider_id, reference_external_transaction_id, kind)
     WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`,
  `CREATE INDEX ix_wtx_pending_due
     ON wager_transactions (next_attempt_at, id)
     WHERE status = 'PENDING_REFERENCE'`,
  `CREATE INDEX ix_wtx_wallet
     ON wager_transactions (wallet_id, created_at) WHERE wallet_id IS NOT NULL`,
  `CREATE UNIQUE INDEX uq_leg_wallet_tx
     ON ledger_entries (wallet_id, transaction_id) WHERE wallet_id IS NOT NULL`,
  `CREATE UNIQUE INDEX uq_leg_wallet_order
     ON ledger_entries (wallet_id, wallet_version, id) WHERE wallet_id IS NOT NULL`,
  `CREATE INDEX ix_leg_journal ON ledger_entries (journal_id)`,
  `CREATE INDEX ix_leg_account ON ledger_entries (account_id, direction)
     WHERE account_id IS NOT NULL`,
  `CREATE INDEX ix_outbox_due ON outbox_messages (next_attempt_at, id)
     WHERE published_at IS NULL`,
];

export class Migration20260101000000_core_tables extends Migration {
  override async up(): Promise<void> {
    for (const sql of DOMAINS) this.addSql(sql);
    for (const sql of TABLES) this.addSql(sql);
    for (const sql of INDEXES) this.addSql(sql);

    // Seed de contrapartidas de abertura por moeda da allow-list (config-driven).
    const currencies = (process.env.SUPPORTED_CURRENCIES ?? 'BRL,USD')
      .split(',')
      .map((code) => code.trim().toUpperCase())
      .filter((code) => code.length > 0);
    for (const currency of currencies) {
      if (!/^[A-Z]{3}$/.test(currency)) {
        throw new Error(`SUPPORTED_CURRENCIES inválido: ${currency}`);
      }
      this.addSql(
        `INSERT INTO accounts (id, code, owner, currency)
         VALUES (gen_random_uuid(), 'OPENING_EQUITY', 'system', '${currency}')
         ON CONFLICT (code, owner, currency) DO NOTHING`,
      );
    }
  }

  override async down(): Promise<void> {
    this.addSql('DROP INDEX IF EXISTS ix_outbox_due');
    this.addSql('DROP INDEX IF EXISTS ix_leg_account');
    this.addSql('DROP INDEX IF EXISTS ix_leg_journal');
    this.addSql('DROP INDEX IF EXISTS uq_leg_wallet_order');
    this.addSql('DROP INDEX IF EXISTS uq_leg_wallet_tx');
    this.addSql('DROP INDEX IF EXISTS ix_wtx_wallet');
    this.addSql('DROP INDEX IF EXISTS ix_wtx_pending_due');
    this.addSql('DROP INDEX IF EXISTS uq_wtx_reversal_once');
    this.addSql('DROP TABLE IF EXISTS outbox_messages');
    this.addSql('DROP TABLE IF EXISTS inbox_messages');
    this.addSql('DROP TABLE IF EXISTS ledger_entries');
    this.addSql('DROP TABLE IF EXISTS journals');
    this.addSql('DROP TABLE IF EXISTS wager_transactions');
    this.addSql('DROP TABLE IF EXISTS accounts');
    this.addSql('DROP TABLE IF EXISTS wallets');
    this.addSql('DROP DOMAIN IF EXISTS leg_direction');
    this.addSql('DROP DOMAIN IF EXISTS tx_status');
    this.addSql('DROP DOMAIN IF EXISTS tx_kind');
    this.addSql('DROP DOMAIN IF EXISTS failure_code');
    this.addSql('DROP DOMAIN IF EXISTS currency_code');
    this.addSql('DROP DOMAIN IF EXISTS money_amount');
  }
}
