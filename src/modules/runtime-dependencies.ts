import type { MikroORM } from '@mikro-orm/core';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../config/env';
import type {
  LoggerPort,
  MetricsPort,
  Tracer,
} from '../contexts/wagering/application/ports/misc-ports';

/** Dependências já construídas no bootstrap (pool, logger, métricas, tracer, SQS). */
export interface RuntimeDependencies {
  readonly config: AppConfig;
  readonly orm: MikroORM;
  readonly sqs: SQSClient;
  readonly logger: LoggerPort;
  readonly metrics: MetricsPort;
  readonly tracer: Tracer;
}
