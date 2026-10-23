import type { OutboxMessage, TraceContext } from '../../domain/outbox/outbox-message';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface EventPublisher {
  /** Publicação **fora** da transação (nunca com lock de linha aberto). */
  publish(message: OutboxMessage): Promise<void>;
}

export interface ProviderDirectory {
  isAllowed(providerId: string): boolean;
}

export interface SpanHandle {
  setAttribute(key: string, value: string | number | boolean): void;
  setAttributes(attributes: Record<string, unknown>): void;
  recordError(error: unknown): void;
}

export interface Tracer {
  withSpan<T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T>;
  withRemoteSpan<T>(
    remote: TraceContext | null,
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T>;
  /** injeta o contexto atual (outbox enqueue) */
  injectTraceContext(): TraceContext | null;
}

export interface LoggerPort {
  debug(payload: Record<string, unknown>, message?: string): void;
  info(payload: Record<string, unknown>, message?: string): void;
  warn(payload: Record<string, unknown>, message?: string): void;
  error(payload: Record<string, unknown>, message?: string): void;
  child(bindings: Record<string, unknown>): LoggerPort;
}

export interface MetricsPort {
  observeHttp(route: string, method: string, statusClass: string, seconds: number): void;
  recordTransaction(kind: string, status: string, provider: string): void;
  recordDuplicate(type: 'replay' | 'conflict', channel: 'http' | 'sqs'): void;
  recordSqs(queue: string, result: 'ack' | 'retry' | 'dlq'): void;
  observeSqs(queue: string, seconds: number): void;
  setSqsInflight(queue: string, value: number): void;
  recordDlq(queue: string): void;
  recordTransactionRetry(sqlstate: string): void;
  recordLockConflict(sqlstate: string): void;
  setOutboxBacklog(value: number): void;
  setOutboxLag(seconds: number): void;
  recordOutboxPublish(result: 'ok' | 'retry' | 'poison'): void;
  setPendingBacklog(value: number): void;
  recordPendingRetry(): void;
  recordReconciliationDivergence(source: 'endpoint' | 'job'): void;
  recordReconciliationChecked(source: 'endpoint' | 'job', entries: number): void;
  recordRetentionDeleted(table: string, rows: number): void;
  setPoolMetrics(total: number, idle: number, waiting: number): void;
  render(): Promise<string>;
  contentType: string;
}

export interface HealthProbeResult {
  readonly pg: 'up' | 'down';
  readonly sqs: 'up' | 'down';
}

export interface ReadinessProbe {
  check(): Promise<HealthProbeResult>;
}
