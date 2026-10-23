import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { FastifyReply } from 'fastify';
import { createSqsClient } from '../../src/contexts/wagering/infrastructure/messaging/sqs.client';
import { HealthController } from '../../src/contexts/wagering/infrastructure/http/controllers/health.controller';
import { ReadinessProbeImpl } from '../../src/contexts/wagering/infrastructure/http/health.probe';
import { buildOrmConfig } from '../../src/contexts/wagering/infrastructure/persistence/mikro-orm.config';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '../helpers/isolated-db';
import { TEST_DATABASE_URL } from '../helpers/infra';

const SQS_ENDPOINT = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
const LIVE_QUEUE = `${SQS_ENDPOINT}/000000000000/wager-transactions.fifo`;
const MISSING_QUEUE = `${SQS_ENDPOINT}/000000000000/fila-que-nao-existe.fifo`;

const fakeReply = (): { reply: FastifyReply; statusCode: () => number } => {
  let code = 200;
  const reply = {
    status(next: number) {
      code = next;
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, statusCode: () => code };
};

let db: IsolatedDatabase;
let migratorOrm: MikroORM;

beforeAll(async () => {
  db = await createIsolatedDatabase('it_infra');
}, 120_000);

afterAll(async () => {
  await migratorOrm?.close(true);
  await db?.drop();
}, 120_000);

describe('Infra e health (IT-INFRA-01 / IT-HEALTH-01)', () => {
  it('IT-INFRA-01: migrate up → down → up em base limpa, com grants de menor privilégio', async () => {
    migratorOrm = await MikroORM.init(buildOrmConfig(db.migratorUrl, 2));
    const migrator = migratorOrm.getMigrator();
    const executed = await migrator.up();
    expect(executed.length).toBeGreaterThanOrEqual(5);

    const tables = await migratorOrm.em
      .fork()
      .getConnection()
      .execute<Array<{ name: string }>>(
        `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
        [],
        'all',
      );
    const names = tables.map((table) => table.name);
    for (const expected of [
      'wallets',
      'wager_transactions',
      'journals',
      'ledger_entries',
      'accounts',
      'inbox_messages',
      'outbox_messages',
    ]) {
      expect(names).toContain(expected);
    }

    const [grants] = await migratorOrm.em
      .fork()
      .getConnection()
      .execute<Array<Record<string, boolean>>>(
        `SELECT has_table_privilege('wagering_app', 'ledger_entries', 'UPDATE') AS ledger_update,
                has_table_privilege('wagering_app', 'ledger_entries', 'DELETE') AS ledger_delete,
                has_table_privilege('wagering_app', 'wallets', 'UPDATE') AS wallet_update,
                has_table_privilege('wagering_app', 'outbox_messages', 'DELETE') AS outbox_delete`,
        [],
        'all',
      );
    expect(grants.ledger_update).toBe(false);
    expect(grants.ledger_delete).toBe(false);
    expect(grants.wallet_update).toBe(true);
    expect(grants.outbox_delete).toBe(true);

    const applied = await migrator.getExecutedMigrations();
    // down na ordem inversa da aplicação (dependências de FK/trigger)
    await migrator.down({
      migrations: applied.map((migration) => migration.name).reverse(),
    });
    const afterDown = await migratorOrm.em
      .fork()
      .getConnection()
      .execute<Array<{ exists: boolean }>>(
        `SELECT to_regclass('public.ledger_entries') IS NOT NULL AS exists`,
        [],
        'all',
      );
    expect(afterDown[0].exists).toBe(false);

    await migrator.up();
    const afterUp = await migratorOrm.em
      .fork()
      .getConnection()
      .execute<Array<{ exists: boolean }>>(
        `SELECT to_regclass('public.ledger_entries') IS NOT NULL AS exists`,
        [],
        'all',
      );
    expect(afterUp[0].exists).toBe(true);
  }, 300_000);

  it('IT-HEALTH-01: readiness degrada por dependência e liveness segue 200 (sem auth)', async () => {
    const sqs = createSqsClient({
      endpoint: SQS_ENDPOINT,
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
    });

    const healthyOrm = await MikroORM.init(buildOrmConfig(TEST_DATABASE_URL, 2));
    const healthy = new ReadinessProbeImpl(healthyOrm, sqs, LIVE_QUEUE, 1_000);
    expect(await healthy.check()).toEqual({ pg: 'up', sqs: 'up' });

    // SQS inalcançável ⇒ ready 503 mesmo com PG saudável
    const noSqs = new ReadinessProbeImpl(healthyOrm, sqs, MISSING_QUEUE, 1_000);
    expect(await noSqs.check()).toEqual({ pg: 'up', sqs: 'down' });

    const { reply, statusCode } = fakeReply();
    const controller = new HealthController(noSqs);
    const body = await controller.ready(reply);
    expect(statusCode()).toBe(503);
    expect(body.status).toBe('degraded');

    // PostgreSQL inalcançável (porta fechada) ⇒ pg down, sqs up
    const closedOrm = await MikroORM.init({
      ...buildOrmConfig('postgres://wagering_app:wagering_app@127.0.0.1:5999/wagering', 1),
      connect: false,
    });
    const noPg = new ReadinessProbeImpl(closedOrm, sqs, LIVE_QUEUE, 1_000);
    expect(await noPg.check()).toEqual({ pg: 'down', sqs: 'up' });
    await closedOrm.close(true);

    const degradedReply = fakeReply();
    const degradedBody = await new HealthController(noPg).ready(degradedReply.reply);
    expect(degradedReply.statusCode()).toBe(503);
    expect(degradedBody.status).toBe('degraded');

    // liveness é sempre 200 e independente de dependência
    expect(controller.live()).toEqual({ status: 'ok' });

    await healthyOrm.close(true);
  }, 120_000);
});
