import { Module, type DynamicModule } from '@nestjs/common';
import {
  CLOCK,
  CONFIG,
  EVENT_PUBLISHER,
  ID_GENERATOR,
  LOGGER,
  METRICS,
  ORM,
  PROVIDER_DIRECTORY,
  PROVIDER_IDENTITY,
  READINESS_PROBE,
  SQS_CLIENT,
  SUPPORTED_CURRENCIES,
  TRACER,
  TX_RUNNER,
} from '../config/tokens';
import { systemClock } from '../shared/clock/system-clock';
import { uuidv7 } from '../shared/ids/uuid7';
import { JoseProviderIdentityAdapter } from '../contexts/wagering/infrastructure/auth/jose-provider-identity';
import { DisabledProviderIdentity } from '../contexts/wagering/infrastructure/auth/disabled-provider-identity';
import { ReadinessProbeImpl } from '../contexts/wagering/infrastructure/http/health.probe';
import { SqsEventPublisher } from '../contexts/wagering/infrastructure/messaging/sqs-event-publisher';
import { MikroTransactionRunner } from '../contexts/wagering/infrastructure/persistence/mikro-transaction-runner';
import type { RuntimeDependencies } from './runtime-dependencies';

const ALL = [
  CONFIG,
  ORM,
  SQS_CLIENT,
  LOGGER,
  METRICS,
  TRACER,
  CLOCK,
  ID_GENERATOR,
  SUPPORTED_CURRENCIES,
  PROVIDER_DIRECTORY,
  PROVIDER_IDENTITY,
  TX_RUNNER,
  EVENT_PUBLISHER,
  READINESS_PROBE,
];

/** Providers de infraestrutura com injeção 100% explícita por tokens (ADR-13). */
@Module({})
export class CoreModule {
  static forRoot(deps: RuntimeDependencies): DynamicModule {
    const { config } = deps;
    return {
      module: CoreModule,
      global: true,
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: ORM, useValue: deps.orm },
        { provide: SQS_CLIENT, useValue: deps.sqs },
        { provide: LOGGER, useValue: deps.logger },
        { provide: METRICS, useValue: deps.metrics },
        { provide: TRACER, useValue: deps.tracer },
        { provide: CLOCK, useValue: systemClock },
        { provide: ID_GENERATOR, useValue: { next: () => uuidv7() } },
        { provide: SUPPORTED_CURRENCIES, useValue: config.currencies },
        {
          provide: PROVIDER_DIRECTORY,
          useValue: { isAllowed: (providerId: string) => config.providers.has(providerId) },
        },
        {
          provide: PROVIDER_IDENTITY,
          useFactory: () =>
            config.env.AUTH_ENABLED
              ? new JoseProviderIdentityAdapter({
                  jwksUrl: config.env.KEYCLOAK_JWKS_URL,
                  issuer: config.env.KEYCLOAK_ISSUER,
                  audience: config.env.KEYCLOAK_AUDIENCE,
                  algorithms: config.env.JWT_ALGORITHMS.split(',')
                    .map((alg) => alg.trim())
                    .filter((alg) => alg.length > 0),
                  clockToleranceSeconds: config.env.JWT_CLOCK_TOLERANCE_SECONDS,
                })
              : new DisabledProviderIdentity(),
        },
        {
          provide: TX_RUNNER,
          useFactory: (orm: RuntimeDependencies['orm'], metrics: RuntimeDependencies['metrics'], logger: RuntimeDependencies['logger']) =>
            new MikroTransactionRunner(
              orm,
              {
                lockTimeoutMs: config.env.LOCK_TIMEOUT_MS,
                statementTimeoutMs: config.env.STATEMENT_TIMEOUT_MS,
                idleTxTimeoutMs: config.env.IDLE_TX_TIMEOUT_MS,
                maxRetries: config.env.TX_MAX_RETRIES,
                faultInjectionEnabled: config.env.FAULT_INJECTION_ENABLED,
                faultDelayLockMs: config.env.FAULT_DELAY_LOCK_MS,
              },
              metrics,
              logger,
            ),
          inject: [ORM, METRICS, LOGGER],
        },
        {
          provide: EVENT_PUBLISHER,
          useFactory: (sqs: RuntimeDependencies['sqs']) =>
            new SqsEventPublisher(sqs, config.env.SQS_EVENTS_QUEUE_URL),
          inject: [SQS_CLIENT],
        },
        {
          provide: READINESS_PROBE,
          useFactory: (orm: RuntimeDependencies['orm'], sqs: RuntimeDependencies['sqs']) =>
            new ReadinessProbeImpl(orm, sqs, config.env.SQS_TRANSACTIONS_QUEUE_URL),
          inject: [ORM, SQS_CLIENT],
        },
      ],
      exports: ALL,
    };
  }
}
