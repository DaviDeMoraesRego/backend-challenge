/* global __ENV, __VU, __ITER */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

/**
 * Cenários de carga do Distributed Wagering Processor.
 *
 * `setup()` cria as wallets via HTTP (ops-admin) e devolve os dados para os VUs —
 * o teste é autocontido, sem depender de `seed` nem de env por wallet.
 *
 * Execução: `bun run test:load` (k6) ou
 * `docker compose --profile load run --rm k6`.
 * Sem meta de RPS: os números são reportados como medidos.
 */
const TARGETS = (__ENV.TARGETS ?? __ENV.API_URL ?? 'http://localhost:3001')
  .split(',')
  .map((url) => url.trim().replace(/\/$/, ''));
const API = TARGETS[0];
const target = () => TARGETS[(__VU - 1) % TARGETS.length];
const TOKEN_URL =
  __ENV.TOKEN_URL ??
  'http://keycloak:8080/realms/jungle/protocol/openid-connect/token';
const PROVIDER_ID = __ENV.CLIENT_ID ?? 'provider-a';
const PROVIDER_SECRET = __ENV.CLIENT_SECRET ?? 'provider-a-secret';
const ADMIN_ID = __ENV.ADMIN_ID ?? 'ops-admin';
const ADMIN_SECRET = __ENV.ADMIN_SECRET ?? 'ops-admin-secret';
const WALLET_COUNT = Number(__ENV.WALLET_COUNT ?? 50);
const INITIAL_BALANCE = __ENV.INITIAL_BALANCE ?? '100000.00';

// 409/422 são respostas **esperadas** (replay/conflito e rejeição de negócio):
// sem isso o `http_req_failed` mediria o storm de duplicatas, não erro real.
http.setResponseCallback(http.expectedStatuses(200, 201, 202, 409, 422));

const wagerStatus = new Counter('wager_status_total');
const idempotentReplays = new Counter('wager_replay_total');
const rejections = new Counter('wager_rejection_total');
const wagerLatency = new Trend('wager_latency_ms', true);

const token = (clientId, clientSecret) => {
  const response = http.post(
    TOKEN_URL,
    { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret },
    { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
  );
  if (response.status !== 200) {
    throw new Error(`token ${clientId} retornou ${response.status}`);
  }
  return response.json().access_token;
};

const uuid = () => {
  const hex = '0123456789abcdef';
  let out = '';
  for (let index = 0; index < 32; index += 1) {
    out += hex[Math.floor(Math.random() * 16)];
  }
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-7${out.slice(13, 16)}-a${out.slice(17, 20)}-${out.slice(20, 32)}`;
};

export function setup() {
  const admin = token(ADMIN_ID, ADMIN_SECRET);
  const provider = token(PROVIDER_ID, PROVIDER_SECRET);
  const wallets = [];

  for (let index = 0; index < WALLET_COUNT; index += 1) {
    const playerId = uuid();
    const response = http.post(
      `${API}/wallets`,
      JSON.stringify({ playerId, initialBalance: { amount: INITIAL_BALANCE, currency: 'BRL' } }),
      { headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` } },
    );
    if (response.status !== 201) {
      throw new Error(`criação de wallet falhou: ${response.status} ${response.body}`);
    }
    const body = response.json();
    wallets.push({ walletId: body.id, playerId });
  }

  return { wallets, providerToken: provider };
}

const pickWallet = (data) => data.wallets[Math.floor(Math.random() * data.wallets.length)];

function submit(data, wallet, externalTransactionId, kind = 'BET', amount = '1.00') {
  const started = Date.now();
  const response = http.post(
    `${target()}/wagering/transactions`,
    JSON.stringify({
      providerId: PROVIDER_ID,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      // no storm a rodada é fixa: payload idêntico ⇒ replay (201) em vez de conflito
      roundId:
        __ENV.SCENARIO === 'duplicate_storm' ? 'storm-round' : `round-${__VU}-${__ITER}`,
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
    }),
    {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${data.providerToken}`,
        'idempotency-key': `${PROVIDER_ID}:${externalTransactionId}`,
      },
      tags: { scenario: __ENV.SCENARIO ?? 'default' },
    },
  );

  wagerLatency.add(Date.now() - started);
  wagerStatus.add(1, { status: String(response.status) });
  if (response.status === 201 || response.status === 202) {
    const body = response.json();
    if (body && body.idempotentReplay) idempotentReplays.add(1);
  }
  if (response.status === 422) rejections.add(1);
  return response;
}

export const options = {
  scenarios: {
    // O rate limit da borda é 300 req/min por IP **por instância** (limitação
    // documentada): os cenários ficam abaixo desse teto para medir o caminho
    // financeiro, não o 429.
    distinct_wallets: {
      executor: 'ramping-arrival-rate',
      startRate: 4,
      timeUnit: '1s',
      preAllocatedVUs: 10,
      maxVUs: 30,
      stages: [
        { target: 6, duration: '20s' },
        { target: 10, duration: '20s' },
        { target: 12, duration: '20s' },
      ],
      exec: 'distinctWallets',
      tags: { scenario: 'distinct_wallets' },
    },
    hot_wallet: {
      executor: 'constant-vus',
      vus: 3,
      duration: '30s',
      exec: 'hotWallet',
      tags: { scenario: 'hot_wallet' },
      startTime: '61s',
    },
    duplicate_storm: {
      executor: 'constant-vus',
      vus: 1,
      duration: '20s',
      exec: 'duplicateStorm',
      tags: { scenario: 'duplicate_storm' },
      startTime: '92s',
    },
  },
  thresholds: {
    // a invariante é do sistema, não da latência: números reportados como medidos.
    // O storm de duplicatas devolve 409/422 por design, então o threshold de erro
    // é avaliado nos cenários de caminho feliz.
    'http_req_failed{scenario:distinct_wallets}': ['rate<0.05'],
    'http_req_failed{scenario:hot_wallet}': ['rate<0.05'],
    'http_req_duration{scenario:distinct_wallets}': ['p(95)<1500'],
  },
};

export function distinctWallets(data) {
  const wallet = pickWallet(data);
  const externalTransactionId = `load-${Date.now()}-${__VU}-${__ITER}`;
  const response = submit(data, wallet, externalTransactionId);
  check(response, { 'processado (201) ou pendente (202)': (r) => [201, 202].includes(r.status) });
}

export function hotWallet(data) {
  const wallet = data.wallets[0];
  const externalTransactionId = `hot-${Date.now()}-${__VU}-${__ITER}`;
  const response = submit(data, wallet, externalTransactionId);
  check(response, { 'sem 5xx': (r) => r.status < 500 });
  sleep(0.2);
}

export function duplicateStorm(data) {
  const wallet = data.wallets[1 % data.wallets.length];
  const externalTransactionId = `storm-${__VU}-${Math.floor(__ITER / 20)}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = submit(data, wallet, externalTransactionId);
    check(response, { 'replay/conflito esperado': (r) => [201, 202, 409, 422].includes(r.status) });
  }
  sleep(0.1);
}
