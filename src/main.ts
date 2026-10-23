import 'reflect-metadata';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { MikroORM } from '@mikro-orm/postgresql';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadEnv } from './config/env';
import {
  CLOCK,
  EVENT_PUBLISHER,
  OPPORTUNISTIC_SETTLEMENT_TRIGGER,
  SETTLE_WAGER_TRANSACTION,
  SUBMIT_WAGER_TRANSACTION,
  TX_RUNNER,
} from './config/tokens';
import type { SettleWagerTransaction } from './contexts/wagering/application/use-cases/settle-wager-transaction';
import type { SubmitWagerTransaction } from './contexts/wagering/application/use-cases/submit-wager-transaction';
import type {
  Clock,
  EventPublisher,
} from './contexts/wagering/application/ports/misc-ports';
import type { TransactionRunner } from './contexts/wagering/application/ports/unit-of-work';
import { createSqsClient } from './contexts/wagering/infrastructure/messaging/sqs.client';
import { SqsPoller } from './contexts/wagering/infrastructure/messaging/sqs-poller';
import { buildOrmConfig } from './contexts/wagering/infrastructure/persistence/mikro-orm.config';
import { createLogger } from './contexts/wagering/infrastructure/observability/logging/pino.factory';
import { PromMetrics } from './contexts/wagering/infrastructure/observability/metrics/metrics.registry';
import { setupTracing } from './contexts/wagering/infrastructure/observability/tracing/tracing';
import { OutboxPublisher } from './contexts/wagering/infrastructure/workers/outbox-publisher';
import { PendingReferenceWorker } from './contexts/wagering/infrastructure/workers/pending-reference-worker';
import { ReconciliationJob } from './contexts/wagering/infrastructure/workers/reconciliation-job';
import { RetentionJob } from './contexts/wagering/infrastructure/workers/retention-job';
import type { OpportunisticSettlementTrigger } from './contexts/wagering/infrastructure/workers/opportunistic-settlement-trigger';
import { AppModule } from './modules/app.module';
import { resolveRolePlan } from './roles';
import { uuidv7 } from './shared/ids/uuid7';

async function bootstrap(): Promise<void> {
  const config = loadEnv();
  const plan = resolveRolePlan(config);
  const roleLabel = config.roles.join(',');
  const logger = createLogger({
    level: config.env.LOG_LEVEL,
    role: roleLabel,
    instanceId: config.env.INSTANCE_ID,
  });
  const metrics = new PromMetrics(roleLabel, config.env.INSTANCE_ID);
  const tracing = await setupTracing({
    enabled: config.env.OTEL_ENABLED,
    endpoint: config.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: config.env.OTEL_SERVICE_NAME,
    role: roleLabel,
    instanceId: config.env.INSTANCE_ID,
  });

  const orm = await MikroORM.init(
    buildOrmConfig(
      config.env.DATABASE_URL,
      config.env.PG_POOL_MAX,
      config.env.PG_CONNECT_TIMEOUT_MS,
    ),
  );
  const sqs = createSqsClient({
    endpoint: config.env.SQS_ENDPOINT,
    region: config.env.AWS_REGION,
    accessKeyId: config.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.env.AWS_SECRET_ACCESS_KEY,
  });

  const deps = { config, orm, sqs, logger, metrics, tracer: tracing.tracer };

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forBootstrap(deps, plan),
    new FastifyAdapter({ bodyLimit: 16384, trustProxy: false }),
    { logger: false },
  );
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
  });

  const submit = app.get<SubmitWagerTransaction>(SUBMIT_WAGER_TRANSACTION);
  const settle = app.get<SettleWagerTransaction>(SETTLE_WAGER_TRANSACTION);
  const kicker = app.get<OpportunisticSettlementTrigger>(
    OPPORTUNISTIC_SETTLEMENT_TRIGGER,
  );
  const runner = app.get<TransactionRunner>(TX_RUNNER);
  const clock = app.get<Clock>(CLOCK);
  const publisher = app.get<EventPublisher>(EVENT_PUBLISHER);

  const poller = plan.consumer
    ? new SqsPoller(
        sqs,
        submit,
        metrics,
        logger,
        {
          queueUrl: config.env.SQS_TRANSACTIONS_QUEUE_URL,
          dlqUrl: config.env.SQS_TRANSACTIONS_DLQ_URL,
          queueLabel: 'wager-transactions',
          concurrency: config.env.SQS_CONSUMER_CONCURRENCY,
          waitTimeSeconds: config.env.SQS_WAIT_TIME_SECONDS,
          visibilityTimeoutSeconds: config.env.SQS_VISIBILITY_TIMEOUT_SECONDS,
          graceMs: config.env.SHUTDOWN_GRACE_MS,
          faultInjectionEnabled: config.env.FAULT_INJECTION_ENABLED,
          crashAfterCommitBeforeAck: config.env.FAULT_CRASH_AFTER_COMMIT_BEFORE_ACK,
          requireSignature: config.env.SQS_REQUIRE_SIGNATURE,
          signingSecret: config.env.SQS_SIGNING_SECRET,
        },
        kicker,
      )
    : null;

  const outboxPublisher = plan.outboxPublisher
    ? new OutboxPublisher(runner, publisher, clock, metrics, logger, {
        pollMs: config.env.OUTBOX_POLL_MS,
        batchSize: config.env.OUTBOX_BATCH_SIZE,
        leaseMs: config.env.OUTBOX_LEASE_MS,
        maxAttempts: config.env.OUTBOX_MAX_ATTEMPTS,
        faultInjectionEnabled: config.env.FAULT_INJECTION_ENABLED,
        crashAfterClaim: config.env.FAULT_CRASH_AFTER_CLAIM_OUTBOX,
        crashAfterPublish: config.env.FAULT_CRASH_AFTER_PUBLISH_BEFORE_MARK,
      })
    : null;

  const pendingWorker = plan.pendingWorker
    ? new PendingReferenceWorker(
        runner,
        settle,
        metrics,
        logger,
        { next: () => uuidv7() },
        {
          pollMs: config.env.PENDING_WORKER_POLL_MS,
          batchSize: config.env.PENDING_BATCH_SIZE,
          leaseMs: config.env.PENDING_LEASE_MS,
        },
      )
    : null;

  const reconciliationJob = plan.reconciliation
    ? new ReconciliationJob(runner, clock, metrics, logger, {
        sweepMs: config.env.RECONCILE_SWEEP_MS,
        batchSize: config.env.RECONCILE_BATCH_SIZE,
      })
    : null;

  const retentionJob = plan.retention
    ? new RetentionJob(runner, metrics, logger, {
        intervalMs: config.env.RETENTION_INTERVAL_MS,
        outboxRetentionDays: config.env.OUTBOX_RETENTION_DAYS,
        inboxRetentionDays: config.env.INBOX_RETENTION_DAYS,
        batchSize: 5000,
      })
    : null;

  const poolTimer = setInterval(() => {
    try {
      const knex = (orm.em.fork().getConnection() as unknown as {
        getKnex(): {
          client?: {
            pool?: {
              numUsed(): number;
              numFree(): number;
              numPending(): number;
            };
          };
        };
      }).getKnex();
      const pool = knex?.client?.pool;
      if (pool) {
        metrics.setPoolMetrics(
          pool.numUsed() + pool.numFree(),
          pool.numFree(),
          pool.numPending(),
        );
      }
    } catch {
      // métrica é best-effort
    }
  }, 10_000);
  poolTimer.unref();

  await app.listen({ port: config.env.PORT, host: '0.0.0.0' });

  poller?.start();
  outboxPublisher?.start();
  pendingWorker?.start();
  reconciliationJob?.start();
  retentionJob?.start();

  logger.info(
    { roles: [...config.roles], port: config.env.PORT, plan },
    'serviço iniciado',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown solicitado');
    const graceTimer = setTimeout(() => {
      logger.error({}, 'grace period excedido — encerrando à força');
      process.exit(1);
    }, config.env.SHUTDOWN_GRACE_MS + 5_000);

    try {
      await app.close();
      await poller?.stop();
      await outboxPublisher?.stop();
      await pendingWorker?.stop();
      await reconciliationJob?.stop();
      await retentionJob?.stop();
      clearInterval(poolTimer);
      await orm.close(true);
      await tracing.shutdown();
      clearTimeout(graceTimer);
      logger.info({}, 'shutdown concluído');
      process.exit(0);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'falha durante o shutdown',
      );
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

await bootstrap();
