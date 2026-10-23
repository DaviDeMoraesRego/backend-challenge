import { Migration } from '@mikro-orm/migrations';

const REJECT_MUTATION_FN = `CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger is immutable: % not allowed on %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'raise_exception';
END $$`;

const TRIGGERS: readonly string[] = [
  `CREATE TRIGGER trg_leg_no_update BEFORE UPDATE ON ledger_entries
     FOR EACH ROW EXECUTE FUNCTION reject_mutation()`,
  `CREATE TRIGGER trg_leg_no_delete BEFORE DELETE ON ledger_entries
     FOR EACH ROW EXECUTE FUNCTION reject_mutation()`,
  `CREATE TRIGGER trg_leg_no_truncate BEFORE TRUNCATE ON ledger_entries
     FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation()`,
  `CREATE TRIGGER trg_journal_no_update BEFORE UPDATE ON journals
     FOR EACH ROW EXECUTE FUNCTION reject_mutation()`,
  `CREATE TRIGGER trg_journal_no_delete BEFORE DELETE ON journals
     FOR EACH ROW EXECUTE FUNCTION reject_mutation()`,
  `CREATE TRIGGER trg_journal_no_truncate BEFORE TRUNCATE ON journals
     FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation()`,
  `CREATE TRIGGER trg_wtx_no_delete BEFORE DELETE ON wager_transactions
     FOR EACH ROW EXECUTE FUNCTION reject_mutation()`,
  `CREATE TRIGGER trg_wtx_no_truncate BEFORE TRUNCATE ON wager_transactions
     FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation()`,
  `CREATE TRIGGER trg_accounts_no_delete BEFORE DELETE ON accounts
     FOR EACH ROW EXECUTE FUNCTION reject_mutation()`,
];

const DROPS: readonly string[] = [
  'DROP TRIGGER IF EXISTS trg_accounts_no_delete ON accounts',
  'DROP TRIGGER IF EXISTS trg_wtx_no_truncate ON wager_transactions',
  'DROP TRIGGER IF EXISTS trg_wtx_no_delete ON wager_transactions',
  'DROP TRIGGER IF EXISTS trg_journal_no_truncate ON journals',
  'DROP TRIGGER IF EXISTS trg_journal_no_delete ON journals',
  'DROP TRIGGER IF EXISTS trg_journal_no_update ON journals',
  'DROP TRIGGER IF EXISTS trg_leg_no_truncate ON ledger_entries',
  'DROP TRIGGER IF EXISTS trg_leg_no_delete ON ledger_entries',
  'DROP TRIGGER IF EXISTS trg_leg_no_update ON ledger_entries',
  'DROP FUNCTION IF EXISTS reject_mutation()',
];

export class Migration20260101000001_immutability_triggers extends Migration {
  override async up(): Promise<void> {
    this.addSql(REJECT_MUTATION_FN);
    for (const sql of TRIGGERS) this.addSql(sql);
  }

  override async down(): Promise<void> {
    for (const sql of DROPS) this.addSql(sql);
  }
}
