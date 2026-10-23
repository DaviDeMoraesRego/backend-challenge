import type { DbSession } from '../../../application/ports/db-session';
import type { OutboxLag, OutboxRepository } from '../../../application/ports/repositories';
import type { OutboxMessage } from '../../../domain/outbox/outbox-message';
import { asOptionalDate, toOutboxMessage } from '../mappers';
import type { OutboxRow } from '../records';

export class MikroOutboxRepository implements OutboxRepository {
  constructor(private readonly session: DbSession) {}

  async enqueue(message: OutboxMessage): Promise<void> {
    await this.session.query(
      `INSERT INTO outbox_messages (
         id, aggregate_id, event_type, payload, trace_context, occurred_at,
         attempts, next_attempt_at, published_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)`,
      [
        message.id,
        message.aggregateId,
        message.eventType,
        JSON.stringify(message.payload),
        message.traceContext ? JSON.stringify(message.traceContext) : null,
        message.occurredAt,
        message.attempts,
        message.nextAttemptAt,
        message.publishedAt ?? null,
      ],
    );
  }

  /** Claim com lease: `next_attempt_at` funciona como lease (ADR-05). */
  async claimDue(limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    const rows = await this.session.query<OutboxRow>(
      `UPDATE outbox_messages
          SET next_attempt_at = now() + (interval '1 millisecond' * $1::int)
        WHERE id IN (
          SELECT id FROM outbox_messages
           WHERE published_at IS NULL AND next_attempt_at <= now()
           ORDER BY id
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [leaseMs, limit],
    );
    return rows.map(toOutboxMessage);
  }

  async markPublished(id: string, at: Date): Promise<void> {
    await this.session.query(
      `UPDATE outbox_messages SET published_at = $2 WHERE id = $1`,
      [id, at],
    );
  }

  async markPublishedMany(ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.session.query(
      `UPDATE outbox_messages
          SET published_at = $2
        WHERE id::text = ANY(string_to_array($1::text, ','))`,
      [ids.join(','), at],
    );
  }

  async scheduleRetry(id: string, attempts: number, nextAt: Date): Promise<void> {
    await this.session.query(
      `UPDATE outbox_messages SET attempts = $2, next_attempt_at = $3 WHERE id = $1`,
      [id, attempts, nextAt],
    );
  }

  async findById(id: string): Promise<OutboxMessage | null> {
    const row = await this.session.queryOne<OutboxRow>(
      `SELECT * FROM outbox_messages WHERE id = $1`,
      [id],
    );
    return row ? toOutboxMessage(row) : null;
  }

  async lag(): Promise<OutboxLag> {
    const row = await this.session.queryOne<{
      backlog: number;
      oldest: Date | null;
    }>(
      `SELECT COUNT(*)::int AS backlog, MIN(created_at) AS oldest
         FROM outbox_messages WHERE published_at IS NULL`,
    );
    return {
      backlog: Number(row?.backlog ?? 0),
      oldestCreatedAt: asOptionalDate(row?.oldest) ?? null,
    };
  }
}
