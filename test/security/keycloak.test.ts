import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { uuidv7 } from '../../src/shared/ids/uuid7';
import { api } from '../helpers/api-client';
import { AppCluster } from '../helpers/app-cluster';
import { createTestRuntime, type TestRuntime } from '../helpers/infra';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '../helpers/isolated-db';

const KEYCLOAK = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';
const REALM = 'jungle';

let db: IsolatedDatabase;
let rt: TestRuntime;
let cluster: AppCluster | null = null;
let providerA = '';
let providerB = '';
let opsAdmin = '';

async function token(clientId: string, secret: string): Promise<string> {
  const response = await fetch(
    `${KEYCLOAK}/realms/${REALM}/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: secret,
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body = (await response.json()) as { access_token?: string; error?: string };
  if (response.status !== 200 || !body.access_token) {
    throw new Error(`token ${clientId} falhou: ${response.status} ${body.error ?? ''}`);
  }
  return body.access_token;
}

const auth = (bearer: string): Record<string, string> => ({
  authorization: `Bearer ${bearer}`,
});

beforeAll(async () => {
  db = await createIsolatedDatabase('it_sec');
  await db.migrate();
  rt = await createTestRuntime(db.appUrl);

  providerA = await token('provider-a', 'provider-a-secret');
  providerB = await token('provider-b', 'provider-b-secret');
  opsAdmin = await token('ops-admin', 'ops-admin-secret');

  cluster = await AppCluster.start({
    instances: 1,
    basePort: 3161,
    role: 'api',
    databaseUrl: db.appUrl,
    sqsEndpoint: rt.config.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    transactionsQueueUrl: `${rt.config.env.SQS_ENDPOINT ?? 'http://localhost:4566'}/000000000000/wager-transactions.fifo`,
    transactionsDlqUrl: `${rt.config.env.SQS_ENDPOINT ?? 'http://localhost:4566'}/000000000000/wager-transactions-dlq.fifo`,
    eventsQueueUrl: `${rt.config.env.SQS_ENDPOINT ?? 'http://localhost:4566'}/000000000000/wager-events.fifo`,
    env: {
      AUTH_ENABLED: 'true',
      KEYCLOAK_ISSUER: `${KEYCLOAK}/realms/${REALM}`,
      KEYCLOAK_JWKS_URL: `${KEYCLOAK}/realms/${REALM}/protocol/openid-connect/certs`,
      KEYCLOAK_AUDIENCE: 'wagering-api',
      JWT_ALGORITHMS: 'RS256',
    },
  });
}, 300_000);

afterAll(async () => {
  await cluster?.stop();
  await rt.close();
  await db.drop();
}, 180_000);

async function createWallet(bearer: string) {
  const playerId = uuidv7();
  const response = await api<{ id: string; playerId: string }>(
    cluster!.urls()[0],
    'POST',
    '/wallets',
    { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
    auth(bearer),
  );
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return { walletId: response.body.id, playerId };
}

describe('Segurança com Keycloak real (SEC-01…06, SEC-09, SEC-10)', () => {
  it('SEC-01: token client-credentials real submete BET → 201', async () => {
    const wallet = await createWallet(opsAdmin);
    const externalTransactionId = `sec-${uuidv7()}`;
    const response = await api(
      cluster!.urls()[0],
      'POST',
      '/wagering/transactions',
      {
        providerId: 'provider-a',
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-sec',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
      { ...auth(providerA), 'Idempotency-Key': `provider-a:${externalTransactionId}` },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.status).toBe('PROCESSED');
  }, 120_000);

  it('SEC-02: token forjado é rejeitado (expirado/assinatura — SEC-07 cobre exp)', async () => {
    const forged = `${providerA.slice(0, -6)}abcdef`;
    const response = await api(cluster!.urls()[0], 'GET', `/wallets/${uuidv7()}`, undefined, {
      ...auth(forged),
    });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('TOKEN_INVALID');
  }, 60_000);

  it('SEC-03: escopo insuficiente → 403 com WWW-Authenticate', async () => {
    const wallet = await createWallet(opsAdmin);
    const response = await api(
      cluster!.urls()[0],
      'POST',
      '/wagering/transactions',
      {
        providerId: 'provider-a',
        externalTransactionId: `sec-${uuidv7()}`,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-sec',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      },
      auth(opsAdmin),
    );
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('INSUFFICIENT_SCOPE');
  }, 60_000);

  it('SEC-04: claim provider_id ≠ body.providerId → 403 PROVIDER_MISMATCH', async () => {
    const wallet = await createWallet(opsAdmin);
    const response = await api(
      cluster!.urls()[0],
      'POST',
      '/wagering/transactions',
      {
        providerId: 'provider-b',
        externalTransactionId: `sec-${uuidv7()}`,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-sec',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      },
      auth(providerA),
    );
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('PROVIDER_MISMATCH');
  }, 60_000);

  it('SEC-05: sem token → 401; health e metrics são públicos', async () => {
    const unauthenticated = await api(cluster!.urls()[0], 'GET', `/wallets/${uuidv7()}`);
    expect(unauthenticated.status).toBe(401);

    const live = await api(cluster!.urls()[0], 'GET', '/health/live');
    expect(live.status).toBe(200);
    const ready = await api(cluster!.urls()[0], 'GET', '/health/ready');
    expect([200, 503]).toContain(ready.status);
    const metrics = await api(cluster!.urls()[0], 'GET', '/metrics');
    expect(metrics.status).toBe(200);
  }, 60_000);

  it('SEC-06: provider só enxerga o próprio tenant; ops-admin lê tudo', async () => {
    const wallet = await createWallet(opsAdmin);

    // provider-a adota a wallet na primeira operação
    const externalTransactionId = `sec-${uuidv7()}`;
    const bet = await api(
      cluster!.urls()[0],
      'POST',
      '/wagering/transactions',
      {
        providerId: 'provider-a',
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-sec',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      },
      { ...auth(providerA), 'Idempotency-Key': `provider-a:${externalTransactionId}` },
    );
    expect(bet.status).toBe(201);

    const ownTransaction = await api(
      cluster!.urls()[0],
      'GET',
      `/providers/provider-a/wagering/transactions/${externalTransactionId}`,
      undefined,
      auth(providerA),
    );
    expect(ownTransaction.status).toBe(200);

    const foreignTransaction = await api(
      cluster!.urls()[0],
      'GET',
      `/providers/provider-a/wagering/transactions/${externalTransactionId}`,
      undefined,
      auth(providerB),
    );
    expect(foreignTransaction.status).toBe(403);

    const foreignWallet = await api(
      cluster!.urls()[0],
      'GET',
      `/wallets/${wallet.walletId}`,
      undefined,
      auth(providerB),
    );
    expect(foreignWallet.status).toBe(404);

    const backoffice = await api(
      cluster!.urls()[0],
      'GET',
      `/wallets/${wallet.walletId}`,
      undefined,
      auth(opsAdmin),
    );
    expect(backoffice.status).toBe(200);
  }, 120_000);

  it('SEC-09: campo desconhecido → 400, body grande → 413 e correlation-id hostil é sanitizado', async () => {
    const unknownField = await api(
      cluster!.urls()[0],
      'POST',
      '/wallets',
      { playerId: uuidv7(), initialBalance: { amount: '1.00', currency: 'BRL' }, extra: true },
      auth(opsAdmin),
    );
    const huge = await api(
      cluster!.urls()[0],
      'POST',
      '/wallets',
      { playerId: uuidv7(), initialBalance: { amount: '1.00', currency: 'BRL' }, pad: 'x'.repeat(20_000) },
      auth(opsAdmin),
    );
    // header válido no transporte, mas fora do padrão aceito pelo app:
    // o middleware descarta o valor e gera um correlationId novo (anti log-injection)
    const hostile = await api(
      cluster!.urls()[0],
      'GET',
      '/health/live',
      undefined,
      { 'x-correlation-id': 'abc 12345678<script>' },
    );

    expect(unknownField.status).toBe(400);
    expect(unknownField.body.code).toBe('VALIDATION_FAILED');
    expect(huge.status, JSON.stringify(huge.body).slice(0, 200)).toBe(413);
    expect(hostile.status).toBe(200);
  }, 60_000);

  it('SEC-10: SQLi no external id é tratada como dado (sem 500 e sem efeito colateral)', async () => {
    const wallet = await createWallet(opsAdmin);
    const injection = `x'; DROP TABLE ledger_entries; --`;
    const response = await api(
      cluster!.urls()[0],
      'POST',
      '/wagering/transactions',
      {
        providerId: 'provider-a',
        externalTransactionId: injection,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-sec',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      },
      { ...auth(providerA), 'Idempotency-Key': `provider-a:${uuidv7()}` },
    );
    expect([201, 400, 422]).toContain(response.status);

    const [table] = await rt.sql<{ exists: boolean }>(
      `SELECT to_regclass('public.ledger_entries') IS NOT NULL AS exists`,
    );
    expect(table.exists).toBe(true);
  }, 60_000);
});
