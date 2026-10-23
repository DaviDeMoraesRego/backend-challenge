import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { OutboxMessage } from '../../src/contexts/wagering/domain/outbox/outbox-message';
import type { EventPublisher } from '../../src/contexts/wagering/application/ports/misc-ports';
import { PromMetrics } from '../../src/contexts/wagering/infrastructure/observability/metrics/metrics.registry';
import { OutboxPublisher } from '../../src/contexts/wagering/infrastructure/workers/outbox-publisher';
import { systemClock } from '../../src/shared/clock/system-clock';
import { uuidv7 } from '../../src/shared/ids/uuid7';
import {
  createTestRuntime,
  type TestRuntime,
} from '../helpers/infra';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '../helpers/isolated-db';
import { RecordingLogger } from '../helpers/silent-logger';

class RecordingPublisher implements EventPublisher {
  readonly published: string[] = [];
  fail = false;

  async publish(message: OutboxMessage): Promise<void> {
    if (this.fail) throw new Error('SQS indisponível (simulado)');
    this.published.push(message.id);
  }
}

let db: IsolatedDatabase;
let rt: TestRuntime;
let metrics: PromMetrics;
let logger: RecordingLogger;
const recorder = new RecordingPublisher();

const publisherFor = (
  overrides: Partial<ConstructorParameters<typeof OutboxPublisher>[5]> = {},
): OutboxPublisher =>
  new OutboxPublisher(rt.runner, recorder, systemClock, metrics, logger, {
    pollMs: 40,
    batchSize: 40,
    leaseMs: 30_000,
    maxAttempts: 3,
    faultInjectionEnabled: false,
    crashAfterClaim: false,
    crashAfterPublish: false,
    ...overrides,
  });

async function insertEvents(count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => uuidv7());
  for (const id of ids) {
    await rt.sql(
      `INSERT INTO outbox_messages
         (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       VALUES ($1, $2, 'TestEvent', '{}'::jsonb, now(), 0, now())`,
      [id, uuidv7()],
    );
  }
  return ids;
}

beforeAll(async () => {
  db = await createIsolatedDatabase('it_outbox');
  await db.migrate();
  rt = await createTestRuntime(db.appUrl);
  metrics = new PromMetrics('it-outbox', 'it-outbox');
  logger = new RecordingLogger();
}, 180_000);

afterAll(async () => {
  await rt?.close();
  await db?.drop();
}, 120_000);

describe('Transactional Outbox (IT-OUTBOX-03/04/05)', () => {
  it('IT-OUTBOX-03: dois publishers concorrentes → batches disjuntos, zero perda, zero duplo-mark', async () => {
    const ids = await insertEvents(200);
    const first = publisherFor();
    const second = publisherFor();
    const startedAt = recorder.published.length;

    for (let round = 0; round < 60; round += 1) {
      const results = await Promise.all([first.runOnce(), second.runOnce()]);
      if (results.every((result) => result.claimed === 0)) break;
    }

    const mine = recorder.published.slice(startedAt);
    expect(mine).toHaveLength(200);
    expect(new Set(mine).size).toBe(200);

    const [pending] = await rt.sql<{ pending: number }>(
      `SELECT COUNT(*)::int AS pending FROM outbox_messages
        WHERE published_at IS NULL
          AND id::text = ANY(string_to_array($1::text, ','))`,
      [ids.join(',')],
    );
    expect(pending.pending).toBe(0);
  }, 120_000);

  it('IT-OUTBOX-04: falha de publicação agenda backoff exponencial e sai do loop quente', async () => {
    const [id] = await insertEvents(1);
    recorder.fail = true;
    const publisher = publisherFor();

    const run = await publisher.runOnce();
    expect(run.failed).toBeGreaterThanOrEqual(1);

    const [afterFirst] = await rt.sql<{ attempts: number; future: boolean }>(
      `SELECT attempts, next_attempt_at > now() AS future FROM outbox_messages WHERE id = $1`,
      [id],
    );
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.future).toBe(true);

    // lease/backoff ativo ⇒ a linha não é reclamada no ciclo seguinte
    const second = await publisher.runOnce();
    const claimedMine = second.claimed;
    expect(claimedMine).toBe(0);

    recorder.fail = false;
    await rt.sql(`UPDATE outbox_messages SET next_attempt_at = now() WHERE id = $1`, [id]);
    const third = await publisher.runOnce();
    expect(third.published).toBeGreaterThanOrEqual(1);
    const [published] = await rt.sql<{ published: boolean }>(
      `SELECT published_at IS NOT NULL AS published FROM outbox_messages WHERE id = $1`,
      [id],
    );
    expect(published.published).toBe(true);
  }, 60_000);

  it('IT-OUTBOX-05: após maxAttempts o evento vira poison (métrica + fora do loop quente)', async () => {
    const [id] = await insertEvents(1);
    recorder.fail = true;
    const publisher = publisherFor({ maxAttempts: 3 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await rt.sql(`UPDATE outbox_messages SET next_attempt_at = now() WHERE id = $1`, [id]);
      await publisher.runOnce();
    }

    const [row] = await rt.sql<{
      attempts: number;
      published: boolean;
      parked: boolean;
    }>(
      `SELECT attempts, published_at IS NOT NULL AS published,
              next_attempt_at > now() + interval '23 hours' AS parked
         FROM outbox_messages WHERE id = $1`,
      [id],
    );
    expect(row.attempts).toBe(3);
    expect(row.published).toBe(false);
    expect(row.parked).toBe(true);

    const exposition = await metrics.render();
    expect(exposition).toContain('outbox_publish_attempts_total');
    expect(exposition).toContain('poison');

    const next = await publisher.runOnce();
    expect(next.claimed).toBe(0);
    recorder.fail = false;
  }, 60_000);
});
