import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv, type AppConfig } from '../../src/config/env';
import { GetTransaction, GetTransactionByExternalId, GetWallet, ListWalletLedger } from '../../src/contexts/wagering/application/use-cases/queries';
import { OpenWallet } from '../../src/contexts/wagering/application/use-cases/open-wallet';
import { ReconcileWallet } from '../../src/contexts/wagering/application/use-cases/reconcile-wallet';
import { SettleWagerTransaction } from '../../src/contexts/wagering/application/use-cases/settle-wager-transaction';
import { SubmitWagerTransaction } from '../../src/contexts/wagering/application/use-cases/submit-wager-transaction';
import { buildOrmConfig } from '../../src/contexts/wagering/infrastructure/persistence/mikro-orm.config';
import { MikroTransactionRunner } from '../../src/contexts/wagering/infrastructure/persistence/mikro-transaction-runner';
import { executeSql } from '../../src/contexts/wagering/infrastructure/persistence/sql-session';
import { PromMetrics } from '../../src/contexts/wagering/infrastructure/observability/metrics/metrics.registry';
import { NoopTracer } from '../../src/contexts/wagering/infrastructure/observability/tracing/tracing';
import { systemClock } from '../../src/shared/clock/system-clock';
import { uuidv7 } from '../../src/shared/ids/uuid7';
import { RecordingLogger } from './silent-logger';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://wagering_app:wagering_app@localhost:5432/wagering';

export const TEST_MIGRATOR_URL =
  process.env.TEST_DATABASE_URL_MIGRATOR ??
  'postgres://wagering_migrator:wagering_migrator@localhost:5432/wagering';

export interface TestRuntime {
  readonly config: AppConfig;
  readonly orm: MikroORM;
  readonly runner: MikroTransactionRunner;
  readonly metrics: PromMetrics;
  readonly logger: RecordingLogger;
  readonly submit: SubmitWagerTransaction;
  readonly settle: SettleWagerTransaction;
  readonly openWallet: OpenWallet;
  readonly getWallet: GetWallet;
  readonly listLedger: ListWalletLedger;
  readonly getTransaction: GetTransaction;
  readonly getTransactionByExternalId: GetTransactionByExternalId;
  readonly reconcile: ReconcileWallet;
  readonly ids: { next(): string };
  sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/** Sobe migrations (role migrator) — idempotente. */
export async function migrateTestSchema(): Promise<void> {
  const orm = await MikroORM.init(buildOrmConfig(TEST_MIGRATOR_URL, 2));
  try {
    await orm.getMigrator().up();
  } finally {
    await orm.close(true);
  }
}

export async function createTestRuntime(
  databaseUrl: string = TEST_DATABASE_URL,
): Promise<TestRuntime> {
  const config = loadEnv({
    ...process.env,
    DATABASE_URL: databaseUrl,
    AUTH_ENABLED: 'false',
    FAULT_INJECTION_ENABLED: 'false',
  });
  const orm = await MikroORM.init(buildOrmConfig(databaseUrl, 8));
  const metrics = new PromMetrics('test', `it-${process.pid}`);
  const logger = new RecordingLogger();
  const tracer = new NoopTracer();
  const ids = { next: () => uuidv7() };
  const providers = {
    isAllowed: (providerId: string) => config.providers.has(providerId),
  };

  const runner = new MikroTransactionRunner(
    orm,
    {
      lockTimeoutMs: config.env.LOCK_TIMEOUT_MS,
      statementTimeoutMs: config.env.STATEMENT_TIMEOUT_MS,
      idleTxTimeoutMs: config.env.IDLE_TX_TIMEOUT_MS,
      maxRetries: config.env.TX_MAX_RETRIES,
    },
    metrics,
    logger,
  );

  return {
    config,
    orm,
    runner,
    metrics,
    logger,
    ids,
    submit: new SubmitWagerTransaction(
      runner,
      systemClock,
      ids,
      providers,
      config.currencies,
      tracer,
      metrics,
      logger,
    ),
    settle: new SettleWagerTransaction(
      runner,
      systemClock,
      ids,
      tracer,
      metrics,
      logger,
      {
        maxAttempts: config.env.PENDING_MAX_ATTEMPTS,
        ttlHours: config.env.PENDING_TTL_HOURS,
      },
    ),
    openWallet: new OpenWallet(
      runner,
      systemClock,
      ids,
      config.currencies,
      tracer,
      [...config.currencies][0],
    ),
    getWallet: new GetWallet(runner),
    listLedger: new ListWalletLedger(runner),
    getTransaction: new GetTransaction(runner),
    getTransactionByExternalId: new GetTransactionByExternalId(runner),
    reconcile: new ReconcileWallet(runner, metrics, logger),
    sql: async <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
      executeSql<T>(orm.em.fork(), query, params),
    close: async () => {
      await orm.close(true);
    },
  };
}

export interface SubmitOverrides {
  providerId?: string;
  externalTransactionId?: string;
  playerId?: string;
  walletId?: string;
  roundId?: string;
  gameId?: string;
  kind?: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  amount?: string;
  currency?: string;
  referenceExternalTransactionId?: string;
  idempotencyKey?: string;
  correlationId?: string;
}

export function submitCommand(overrides: SubmitOverrides): Parameters<SubmitWagerTransaction['execute']>[0] {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${uuidv7()}`;
  return {
    providerId: overrides.providerId ?? 'provider-a',
    externalTransactionId,
    playerId: overrides.playerId as string,
    walletId: overrides.walletId as string,
    roundId: overrides.roundId ?? 'round-1',
    gameId: overrides.gameId ?? 'fortune-chimp',
    kind: (overrides.kind ?? 'BET') as never,
    money: {
      amount: overrides.amount ?? '25.00',
      currency: overrides.currency ?? 'BRL',
    },
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
    idempotencyKey:
      overrides.idempotencyKey ??
      `${overrides.providerId ?? 'provider-a'}:${externalTransactionId}`,
    channel: 'http',
    correlationId: overrides.correlationId ?? `corr-${uuidv7()}`,
  };
}
