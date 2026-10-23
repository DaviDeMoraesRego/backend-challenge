import type { AppConfig } from '../config/env';

export interface RolePlan {
  readonly http: boolean;
  readonly consumer: boolean;
  readonly outboxPublisher: boolean;
  readonly pendingWorker: boolean;
  readonly reconciliation: boolean;
  readonly retention: boolean;
}

/** Composição por papel: o binário suporta múltiplos papéis no mesmo processo. */
export function resolveRolePlan(config: AppConfig): RolePlan {
  return {
    http: config.has('api'),
    consumer: config.has('sqs-consumer'),
    outboxPublisher: config.has('outbox-publisher'),
    pendingWorker: config.has('pending-reference-worker'),
    reconciliation: config.has('reconciliation-job'),
    retention: config.has('outbox-retention-job'),
  };
}
