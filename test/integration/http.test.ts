import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadEnv } from '../../src/config/env';
import { createSqsClient } from '../../src/contexts/wagering/infrastructure/messaging/sqs.client';
import { buildOrmConfig } from '../../src/contexts/wagering/infrastructure/persistence/mikro-orm.config';
import { createLogger } from '../../src/contexts/wagering/infrastructure/observability/logging/pino.factory';
import { PromMetrics } from '../../src/contexts/wagering/infrastructure/observability/metrics/metrics.registry';
import { NoopTracer } from '../../src/contexts/wagering/infrastructure/observability/tracing/tracing';
import { AppModule } from '../../src/modules/app.module';
import { uuidv7 } from '../../src/shared/ids/uuid7';
import { assertLedgerMatchesBalance } from '../helpers/assert-ledger';
import { TEST_DATABASE_URL, migrateTestSchema } from '../helpers/infra';

let app: NestFastifyApplication;
let orm: MikroORM;
const touchedWallets: string[] = [];

beforeAll(async () => {
  await migrateTestSchema();
  const config = loadEnv({
    ...process.env,
    DATABASE_URL: TEST_DATABASE_URL,
    AUTH_ENABLED: 'false',
    METRICS_ENABLED: 'true',
    LOG_LEVEL: 'silent',
  });
  orm = await MikroORM.init(buildOrmConfig(TEST_DATABASE_URL, 8));
  const sqs = createSqsClient({
    endpoint: config.env.SQS_ENDPOINT,
    region: config.env.AWS_REGION,
    accessKeyId: 'test',
    secretAccessKey: 'test',
  });
  const logger = createLogger({ level: 'silent', role: 'it-http', instanceId: 'it-http' });
  const metrics = new PromMetrics('it-http', 'it-http');

  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forBootstrap(
      { config, orm, sqs, logger, metrics, tracer: new NoopTracer() },
      {
        http: true,
        consumer: false,
        outboxPublisher: false,
        pendingWorker: false,
        reconciliation: false,
        retention: false,
      },
    ),
    new FastifyAdapter({ bodyLimit: 16384 }),
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 90_000);

afterAll(async () => {
  if (orm) {
    await assertLedgerMatchesBalance(orm, touchedWallets);
  }
  await app?.close();
  await orm?.close(true);
}, 60_000);

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: payload as never, headers });

describe('HTTP — contratos, status e RFC 9457 (IT-API)', () => {
  let walletId = '';
  let playerId = '';

  it('POST /wallets cria wallet com OPENING (201, version 2)', async () => {
    playerId = uuidv7();
    const response = await post('/wallets', {
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.version).toBe(2);
    expect(body.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    walletId = body.id;
    touchedWallets.push(walletId);
  }, 60_000);

  it('POST /wallets duplicada devolve 409 WALLET_ALREADY_EXISTS (problem+json)', async () => {
    const response = await post('/wallets', {
      playerId,
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json().code).toBe('WALLET_ALREADY_EXISTS');
  }, 60_000);

  it('POST /wallets com campo desconhecido devolve 400 (zod .strict)', async () => {
    const response = await post('/wallets', {
      playerId: uuidv7(),
      hacker: true,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('VALIDATION_FAILED');
  }, 60_000);

  it('POST /wagering/transactions (BET) devolve 201 e saldo resultante', async () => {
    const externalTransactionId = `transaction-${uuidv7()}`;
    const response = await post(
      '/wagering/transactions',
      {
        providerId: 'provider-a',
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
      { 'idempotency-key': `provider-a:${externalTransactionId}` },
    );
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe('PROCESSED');
    expect(body.balance).toEqual({ amount: '975.00', currency: 'BRL' });
    expect(body.idempotentReplay).toBe(false);
  }, 60_000);

  it('replay devolve o mesmo corpo com idempotentReplay: true', async () => {
    const idempotencyKey = `idem-${uuidv7()}`;
    const payload = {
      providerId: 'provider-a',
      externalTransactionId: `ext-${uuidv7()}`,
      playerId,
      walletId,
      roundId: 'round-replay',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    const first = await post('/wagering/transactions', payload, {
      'idempotency-key': idempotencyKey,
    });
    expect(first.statusCode).toBe(201);

    const replay = await post('/wagering/transactions', payload, {
      'idempotency-key': idempotencyKey,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().idempotentReplay).toBe(true);
    expect(replay.json().transactionId).toBe(first.json().transactionId);
    expect(replay.json().balance).toEqual(first.json().balance);

    const conflict = await post(
      '/wagering/transactions',
      { ...payload, money: { amount: '11.00', currency: 'BRL' } },
      { 'idempotency-key': idempotencyKey },
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('IDEMPOTENCY_CONFLICT');
  }, 60_000);

  it('rejeição de negócio devolve 422 com failureCode estável', async () => {
    const response = await post(
      '/wagering/transactions',
      {
        providerId: 'provider-a',
        externalTransactionId: `ext-${uuidv7()}`,
        playerId,
        walletId,
        roundId: 'round-insufficient',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '999999.00', currency: 'BRL' },
      },
      { 'idempotency-key': `idem-${uuidv7()}` },
    );
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.code).toBe('INSUFFICIENT_FUNDS');
    expect(body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(body.status).toBe(422);
    expect(body.transactionStatus).toBe('REJECTED');
    expect(response.headers['content-type']).toContain('application/problem+json');
  }, 60_000);

  it('REFUND sem referência devolve 202 (PENDING_REFERENCE)', async () => {
    const response = await post(
      '/wagering/transactions',
      {
        providerId: 'provider-a',
        externalTransactionId: `ext-${uuidv7()}`,
        playerId,
        walletId,
        roundId: 'round-pending',
        gameId: 'fortune-chimp',
        kind: 'REFUND',
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: `missing-${uuidv7()}`,
      },
      { 'idempotency-key': `idem-${uuidv7()}` },
    );
    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe('PENDING_REFERENCE');
  }, 60_000);

  it('GET /wallets/:id e ledger com cursor opaco', async () => {
    const wallet = await app.inject({ method: 'GET', url: `/wallets/${walletId}` });
    expect(wallet.statusCode).toBe(200);
    expect(wallet.json().id).toBe(walletId);

    const ledger = await app.inject({
      method: 'GET',
      url: `/wallets/${walletId}/ledger?limit=2`,
    });
    expect(ledger.statusCode).toBe(200);
    const body = ledger.json();
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.nextCursor).toBeTruthy();

    const next = await app.inject({
      method: 'GET',
      url: `/wallets/${walletId}/ledger?limit=2&cursor=${body.nextCursor}`,
    });
    expect(next.statusCode).toBe(200);

    const invalid = await app.inject({
      method: 'GET',
      url: `/wallets/${walletId}/ledger?cursor=nao-e-base64`,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('INVALID_CURSOR');
  }, 60_000);

  it('GET inexistente devolve 404 problem+json', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/wallets/${uuidv7()}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('WALLET_NOT_FOUND');
  }, 60_000);

  it('POST reconciliação devolve o contrato do README', async () => {
    const response = await post(`/wallets/${walletId}/reconciliation`, {});
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.consistent).toBe(true);
    expect(body.difference).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(typeof body.checkedEntries).toBe('number');
  }, 60_000);

  it('health e metrics são abertos; readiness reflete as dependências', async () => {
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok' });

    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect([200, 503]).toContain(ready.statusCode);
    expect(['up', 'down']).toContain(ready.json().pg);

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('wager_transactions_total');
    expect(metrics.body).toContain('outbox_backlog');
  }, 60_000);
});
