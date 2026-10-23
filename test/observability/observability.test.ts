import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createLogger } from '../../src/contexts/wagering/infrastructure/observability/logging/pino.factory';
import { requestContext } from '../../src/contexts/wagering/infrastructure/observability/als/request-context';
import { PromMetrics } from '../../src/contexts/wagering/infrastructure/observability/metrics/metrics.registry';
import { uuidv7 } from '../../src/shared/ids/uuid7';
import { api, betBody } from '../helpers/api-client';
import { AppCluster } from '../helpers/app-cluster';
import { eventually } from '../helpers/eventually';
import { createTestRuntime, type TestRuntime } from '../helpers/infra';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '../helpers/isolated-db';

const PROMETHEUS = process.env.PROMETHEUS_URL ?? 'http://localhost:9090';
const GRAFANA = process.env.GRAFANA_URL ?? 'http://localhost:3000';
const JAEGER = process.env.JAEGER_URL ?? 'http://localhost:16686';
const GRAFANA_AUTH = `Basic ${btoa('admin:admin')}`;

let db: IsolatedDatabase;
let rt: TestRuntime;
let cluster: AppCluster | null = null;

const REQUIRED_METRICS = [
  'wager_transactions_total',
  'wager_duplicates_total',
  'db_transaction_retries_total',
  'db_lock_conflicts_total',
  'dlq_messages_total',
  'sqs_messages_total',
  'sqs_processing_duration_seconds',
  'outbox_lag_seconds',
  'outbox_backlog',
  'pending_reference_backlog',
  'reconciliation_divergences_total',
  'http_request_duration_seconds',
];

const get = async (url: string, headers: Record<string, string> = {}) => {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  return { status: response.status, text: await response.text() };
};

beforeAll(async () => {
  db = await createIsolatedDatabase('it_obs');
  await db.migrate();
  rt = await createTestRuntime(db.appUrl);
  cluster = await AppCluster.start({
    instances: 1,
    basePort: 3171,
    role: 'api,sqs-consumer,outbox-publisher',
    databaseUrl: db.appUrl,
    sqsEndpoint: rt.config.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    transactionsQueueUrl: `${rt.config.env.SQS_ENDPOINT ?? 'http://localhost:4566'}/000000000000/wager-transactions.fifo`,
    transactionsDlqUrl: `${rt.config.env.SQS_ENDPOINT ?? 'http://localhost:4566'}/000000000000/wager-transactions-dlq.fifo`,
    eventsQueueUrl: `${rt.config.env.SQS_ENDPOINT ?? 'http://localhost:4566'}/000000000000/wager-events.fifo`,
    env: { LOG_LEVEL: 'info' },
  });
}, 300_000);

afterAll(async () => {
  await cluster?.stop();
  await rt.close();
  await db.drop();
}, 180_000);

describe('Observabilidade (OBS-02…05, OBS-TRACE-01) e stack de infra (IT-INFRA-02)', () => {
  it('OBS-02: /metrics expõe todas as séries obrigatórias após fluxo misto', async () => {
    const playerId = uuidv7();
    const wallet = await api<{ id: string }>(cluster!.urls()[0], 'POST', '/wallets', {
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(wallet.status).toBe(201);
    const externalTransactionId = `obs-${uuidv7()}`;
    const bet = await api(cluster!.urls()[0], 'POST', '/wagering/transactions',
      betBody({ playerId, walletId: wallet.body.id, externalTransactionId, amount: '5.00' }),
      { 'Idempotency-Key': `provider-a:${externalTransactionId}` },
    );
    expect(bet.status).toBe(201);

    const metrics = await get(`${cluster!.urls()[0]}/metrics`);
    expect(metrics.status).toBe(200);
    for (const metric of REQUIRED_METRICS) {
      expect(metrics.text, `métrica ausente: ${metric}`).toContain(metric);
    }
    expect(metrics.text).toContain('kind="BET"');
    expect(metrics.text).toContain('status="PROCESSED"');
  }, 120_000);

  it('OBS-03: cardinalidade — nenhum label carrega walletId/playerId/transactionId', async () => {
    const metrics = await get(`${cluster!.urls()[0]}/metrics`);
    const exposition = metrics.text;
    expect(exposition).not.toMatch(/wallet_?id\s*=/i);
    expect(exposition).not.toMatch(/player_?id\s*=/i);
    expect(exposition).not.toMatch(/transaction_?id\s*=/i);
    expect(exposition).not.toMatch(/message_?id\s*=/i);
  }, 60_000);

  it('OBS-04: logs JSON carregam correlação (ALS) e redigem authorization/payload', async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    const patched = (chunk: unknown): boolean => {
      chunks.push(String(chunk));
      return true;
    };
    process.stdout.write = patched as typeof process.stdout.write;

    const correlationId = `obs-${uuidv7()}`;
    const secret = `segredo-${uuidv7()}`;
    try {
      const logger = createLogger({ level: 'info', role: 'it', instanceId: 'it-obs' });
      await requestContext.run(
        {
          correlationId,
          walletId: uuidv7(),
          providerId: 'provider-a',
          transactionId: uuidv7(),
        },
        async () => {
          logger.info(
            {
              authorization: `Bearer ${secret}`,
              money: { amount: '5.00', currency: 'BRL' },
              payload: { amount: '5.00' },
            },
            'evento de teste',
          );
        },
      );
    } finally {
      process.stdout.write = original;
    }

    const output = chunks.join('');
    expect(output).toContain(correlationId);
    expect(output).toContain('"role":"it"');
    expect(output).toContain('[redacted]');
    expect(output).not.toContain(secret);
    expect(output).not.toContain('5.00');
  }, 60_000);

  it('OBS-05: gauges da outbox/pending expõem valores e aparecem no processo real', async () => {
    const registry = new PromMetrics('it-obs', 'it-obs');
    registry.setOutboxBacklog(7);
    registry.setOutboxLag(12.5);
    registry.setPendingBacklog(3);
    const rendered = await registry.render();
    const valueOf = (name: string): number => {
      const match = new RegExp(`${name}\\{[^}]*\\}\\s+([\\d.]+)`).exec(rendered);
      return match ? Number(match[1]) : Number.NaN;
    };
    expect(valueOf('outbox_backlog')).toBe(7);
    expect(valueOf('outbox_lag_seconds')).toBe(12.5);
    expect(valueOf('pending_reference_backlog')).toBe(3);

    const playerId = uuidv7();
    const wallet = await api<{ id: string }>(cluster!.urls()[0], 'POST', '/wallets', {
      playerId,
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });
    expect(wallet.status).toBe(201);

    // o publisher roda `refreshGauges` a cada ciclo: a série passa a existir
    await eventually(
      async () => {
        const metrics = await get(`${cluster!.urls()[0]}/metrics`);
        expect(metrics.text).toMatch(/outbox_backlog\{[^}]*\}\s+\d/);
        expect(metrics.text).toMatch(/outbox_lag_seconds\{[^}]*\}\s+\d/);
      },
      { timeoutMs: 30_000, intervalMs: 500, message: 'gauges da outbox expostos' },
    );
  }, 120_000);

  it('IT-INFRA-02: Prometheus scrapeia as instâncias e o dashboard do Grafana está provisionado', async () => {
    const targets = JSON.parse((await get(`${PROMETHEUS}/api/v1/targets`)).text) as {
      status: string;
      data: { activeTargets: Array<{ scrapeUrl: string; health: string }> };
    };
    expect(targets.status).toBe('success');
    expect(targets.data.activeTargets.length).toBeGreaterThan(0);
    expect(targets.data.activeTargets.some((target) => target.health === 'up')).toBe(true);

    const health = await get(`${GRAFANA}/api/health`);
    expect(health.status).toBe(200);

    const dashboards = JSON.parse(
      (await get(`${GRAFANA}/api/search?query=wagering`, { authorization: GRAFANA_AUTH })).text,
    ) as Array<{ uid: string; title: string }>;
    expect(dashboards.some((dashboard) => /wagering/i.test(dashboard.title))).toBe(true);
  }, 120_000);

  it('OBS-TRACE-01: Jaeger recebe traces do serviço wagering-api exportados via OTel', async () => {
    const services = JSON.parse((await get(`${JAEGER}/api/services`)).text) as {
      data: string[];
    };
    expect(services.data).toContain('wagering-api');

    const traces = JSON.parse(
      (await get(`${JAEGER}/api/traces?service=wagering-api&limit=5`)).text,
    ) as { data: Array<{ spans: unknown[] }> };
    expect(traces.data.length).toBeGreaterThan(0);
    const richest = traces.data
      .map((trace) => trace.spans.length)
      .sort((a, b) => b - a)[0];
    expect(richest).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
