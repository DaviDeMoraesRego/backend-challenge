import type { DbSession } from '../../../application/ports/db-session';
import type {
  InboxClaimResult,
  InboxRepository,
} from '../../../application/ports/repositories';
import type { InboxMessage } from '../../../domain/inbox/inbox-message';

export class MikroInboxRepository implements InboxRepository {
  constructor(private readonly session: DbSession) {}

  async claim(message: InboxMessage): Promise<InboxClaimResult> {
    const inserted = await this.session.queryOne<{ message_id: string }>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
      ],
    );
    if (inserted) {
      return { inserted: true, alreadyProcessed: false };
    }
    const existing = await this.session.queryOne<{ processed_at: Date | null }>(
      `SELECT processed_at FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2`,
      [message.consumerName, message.messageId],
    );
    return { inserted: false, alreadyProcessed: existing?.processed_at != null };
  }

  async markProcessed(
    consumerName: string,
    messageId: string,
    at: Date,
  ): Promise<void> {
    await this.session.query(
      `UPDATE inbox_messages SET processed_at = $3
       WHERE consumer_name = $1 AND message_id = $2`,
      [consumerName, messageId, at],
    );
  }
}
