import { Migration } from '@mikro-orm/migrations';

const CHECK_JOURNAL_BALANCED = `CREATE OR REPLACE FUNCTION check_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_debits  NUMERIC(19,2); v_credits NUMERIC(19,2);
  v_journal_currency CHAR(3); v_bad_currency INT;
BEGIN
  SELECT j.currency INTO v_journal_currency FROM journals j WHERE j.id = NEW.journal_id;
  SELECT COUNT(*) INTO v_bad_currency FROM ledger_entries e
   WHERE e.journal_id = NEW.journal_id AND e.currency <> v_journal_currency;
  SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DEBIT'), 0),
         COALESCE(SUM(amount) FILTER (WHERE direction='CREDIT'), 0)
    INTO v_debits, v_credits
    FROM ledger_entries WHERE journal_id = NEW.journal_id;
  IF v_bad_currency > 0 THEN
    RAISE EXCEPTION 'journal % has entries in mixed currencies', NEW.journal_id USING ERRCODE='23514';
  END IF;
  IF v_debits <> v_credits THEN
    RAISE EXCEPTION 'journal % unbalanced: debits=% credits=%', NEW.journal_id, v_debits, v_credits
      USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$`;

const CHECK_WALLET_BALANCE = `CREATE OR REPLACE FUNCTION check_wallet_balance_matches_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_last money_amount;
BEGIN
  IF NEW.balance IS NOT DISTINCT FROM OLD.balance THEN RETURN NULL; END IF;
  SELECT e.balance_after INTO v_last
    FROM ledger_entries e
   WHERE e.wallet_id = NEW.id
   ORDER BY e.wallet_version DESC, e.id DESC LIMIT 1;
  IF v_last IS NULL OR v_last <> NEW.balance THEN
    RAISE EXCEPTION 'wallet % balance % does not match last ledger balance_after %',
      NEW.id, NEW.balance, v_last USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$`;

const GRANTS = `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wagering_app') THEN
    EXECUTE 'GRANT CONNECT ON DATABASE ' || current_database() || ' TO wagering_app';
    EXECUTE 'GRANT USAGE ON SCHEMA public TO wagering_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON wallets, wager_transactions, outbox_messages TO wagering_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON inbox_messages TO wagering_app';
    EXECUTE 'GRANT SELECT, INSERT ON journals, ledger_entries, accounts TO wagering_app';
    EXECUTE 'GRANT DELETE ON outbox_messages, inbox_messages TO wagering_app';
    EXECUTE 'REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM wagering_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON journals, ledger_entries, accounts FROM wagering_app';
  END IF;
END $$`;

const REVOKE = `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wagering_app') THEN
    EXECUTE 'REVOKE ALL ON wallets, wager_transactions, outbox_messages, inbox_messages,
      journals, ledger_entries, accounts FROM wagering_app';
  END IF;
END $$`;

export class Migration20260101000002_deferred_constraints_and_roles extends Migration {
  override async up(): Promise<void> {
    this.addSql(CHECK_JOURNAL_BALANCED);
    this.addSql(`CREATE CONSTRAINT TRIGGER trg_journal_balanced
      AFTER INSERT ON ledger_entries
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION check_journal_balanced()`);

    this.addSql(CHECK_WALLET_BALANCE);
    this.addSql(`CREATE CONSTRAINT TRIGGER trg_wallet_balance_consistency
      AFTER UPDATE OF balance ON wallets
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION check_wallet_balance_matches_ledger()`);

    this.addSql(GRANTS);
  }

  override async down(): Promise<void> {
    this.addSql(REVOKE);
    this.addSql(
      'DROP TRIGGER IF EXISTS trg_wallet_balance_consistency ON wallets',
    );
    this.addSql(
      'DROP FUNCTION IF EXISTS check_wallet_balance_matches_ledger()',
    );
    this.addSql('DROP TRIGGER IF EXISTS trg_journal_balanced ON ledger_entries');
    this.addSql('DROP FUNCTION IF EXISTS check_journal_balanced()');
  }
}
