import { Migration } from '@mikro-orm/migrations';

export class Migration20260101000003_retention_indexes extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE INDEX ix_inbox_retention ON inbox_messages (processed_at)
      WHERE processed_at IS NOT NULL`);
    this.addSql(`CREATE INDEX ix_outbox_retention ON outbox_messages (published_at)
      WHERE published_at IS NOT NULL`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP INDEX IF EXISTS ix_outbox_retention');
    this.addSql('DROP INDEX IF EXISTS ix_inbox_retention');
  }
}
