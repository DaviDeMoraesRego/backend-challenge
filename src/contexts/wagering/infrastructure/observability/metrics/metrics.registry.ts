import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import type { MetricsPort } from '../../../application/ports/misc-ports';

/**
 * Métricas exclusivamente via prom-client (ADR-10 — sem OTel Metrics).
 * Labels de negócio de alta cardinalidade são proibidos (walletId/playerId/...).
 */
export class PromMetrics implements MetricsPort {
  readonly contentType = 'text/plain; version=0.0.4; charset=utf-8';
  private readonly registry = new Registry();

  private readonly httpDuration: Histogram<'route' | 'method' | 'status_class'>;
  private readonly transactions: Counter<'kind' | 'status' | 'provider'>;
  private readonly duplicates: Counter<'type' | 'channel'>;
  private readonly sqsMessages: Counter<'queue' | 'result'>;
  private readonly sqsDuration: Histogram<'queue'>;
  private readonly sqsInflight: Gauge<'queue'>;
  private readonly dlq: Counter<'queue'>;
  private readonly txRetries: Counter<'sqlstate'>;
  private readonly lockConflicts: Counter<'sqlstate'>;
  private readonly outboxLag: Gauge<string>;
  private readonly outboxBacklog: Gauge<string>;
  private readonly outboxAttempts: Counter<'result'>;
  private readonly pendingBacklog: Gauge<string>;
  private readonly pendingRetries: Counter<string>;
  private readonly reconDivergences: Counter<'source'>;
  private readonly reconChecked: Counter<'source'>;
  private readonly retentionDeleted: Counter<'table'>;
  private readonly poolTotal: Gauge<string>;
  private readonly poolIdle: Gauge<string>;
  private readonly poolWaiting: Gauge<string>;

  constructor(role: string, instanceId: string) {
    this.registry.setDefaultLabels({ service: 'wagering', role, instance: instanceId });

    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Latência de requisições HTTP',
      labelNames: ['route', 'method', 'status_class'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
      registers: [this.registry],
    });
    this.transactions = new Counter({
      name: 'wager_transactions_total',
      help: 'Transações de aposta por status',
      labelNames: ['kind', 'status', 'provider'] as const,
      registers: [this.registry],
    });
    this.duplicates = new Counter({
      name: 'wager_duplicates_total',
      help: 'Duplicatas detectadas (replay/conflito)',
      labelNames: ['type', 'channel'] as const,
      registers: [this.registry],
    });
    this.sqsMessages = new Counter({
      name: 'sqs_messages_total',
      help: 'Resultado de consumo por fila',
      labelNames: ['queue', 'result'] as const,
      registers: [this.registry],
    });
    this.sqsDuration = new Histogram({
      name: 'sqs_processing_duration_seconds',
      help: 'Latência de processamento por mensagem',
      labelNames: ['queue'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers: [this.registry],
    });
    this.sqsInflight = new Gauge({
      name: 'sqs_inflight',
      help: 'Mensagens em processamento',
      labelNames: ['queue'] as const,
      registers: [this.registry],
    });
    this.dlq = new Counter({
      name: 'dlq_messages_total',
      help: 'Mensagens enviadas explicitamente para a DLQ',
      labelNames: ['queue'] as const,
      registers: [this.registry],
    });
    this.txRetries = new Counter({
      name: 'db_transaction_retries_total',
      help: 'Retries do TransactionRunner',
      labelNames: ['sqlstate'] as const,
      registers: [this.registry],
    });
    this.lockConflicts = new Counter({
      name: 'db_lock_conflicts_total',
      help: 'Conflitos de lock/serialização',
      labelNames: ['sqlstate'] as const,
      registers: [this.registry],
    });
    this.outboxLag = new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Idade do evento pendente mais antigo',
      registers: [this.registry],
    });
    this.outboxBacklog = new Gauge({
      name: 'outbox_backlog',
      help: 'Eventos pendentes de publicação',
      registers: [this.registry],
    });
    this.outboxAttempts = new Counter({
      name: 'outbox_publish_attempts_total',
      help: 'Tentativas de publicação da outbox',
      labelNames: ['result'] as const,
      registers: [this.registry],
    });
    this.pendingBacklog = new Gauge({
      name: 'pending_reference_backlog',
      help: 'Transações aguardando referência',
      registers: [this.registry],
    });
    this.pendingRetries = new Counter({
      name: 'pending_reference_retries_total',
      help: 'Reprocessamentos de referência pendente',
      registers: [this.registry],
    });
    this.reconDivergences = new Counter({
      name: 'reconciliation_divergences_total',
      help: 'Divergências de reconciliação detectadas',
      labelNames: ['source'] as const,
      registers: [this.registry],
    });
    this.reconChecked = new Counter({
      name: 'reconciliation_checked_entries_total',
      help: 'Lançamentos verificados na reconciliação',
      labelNames: ['source'] as const,
      registers: [this.registry],
    });
    this.retentionDeleted = new Counter({
      name: 'retention_deleted_total',
      help: 'Linhas removidas pela retenção',
      labelNames: ['table'] as const,
      registers: [this.registry],
    });
    this.poolTotal = new Gauge({
      name: 'pg_pool_total',
      help: 'Conexões totais no pool',
      registers: [this.registry],
    });
    this.poolIdle = new Gauge({
      name: 'pg_pool_idle',
      help: 'Conexões ociosas no pool',
      registers: [this.registry],
    });
    this.poolWaiting = new Gauge({
      name: 'pg_pool_waiting',
      help: 'Requisições aguardando conexão',
      registers: [this.registry],
    });

    collectDefaultMetrics({ register: this.registry, prefix: 'node_' });
  }

  observeHttp(route: string, method: string, statusClass: string, seconds: number): void {
    this.httpDuration.labels(route, method, statusClass).observe(seconds);
  }

  recordTransaction(kind: string, status: string, provider: string): void {
    this.transactions.labels(kind, status, provider).inc();
  }

  recordDuplicate(type: 'replay' | 'conflict', channel: 'http' | 'sqs'): void {
    this.duplicates.labels(type, channel).inc();
  }

  recordSqs(queue: string, result: 'ack' | 'retry' | 'dlq'): void {
    this.sqsMessages.labels(queue, result).inc();
  }

  observeSqs(queue: string, seconds: number): void {
    this.sqsDuration.labels(queue).observe(seconds);
  }

  setSqsInflight(queue: string, value: number): void {
    this.sqsInflight.labels(queue).set(value);
  }

  recordDlq(queue: string): void {
    this.dlq.labels(queue).inc();
  }

  recordTransactionRetry(sqlstate: string): void {
    this.txRetries.labels(sqlstate).inc();
  }

  recordLockConflict(sqlstate: string): void {
    this.lockConflicts.labels(sqlstate).inc();
  }

  setOutboxBacklog(value: number): void {
    this.outboxBacklog.set(value);
  }

  setOutboxLag(seconds: number): void {
    this.outboxLag.set(seconds);
  }

  recordOutboxPublish(result: 'ok' | 'retry' | 'poison'): void {
    this.outboxAttempts.labels(result).inc();
  }

  setPendingBacklog(value: number): void {
    this.pendingBacklog.set(value);
  }

  recordPendingRetry(): void {
    this.pendingRetries.inc();
  }

  recordReconciliationDivergence(source: 'endpoint' | 'job'): void {
    this.reconDivergences.labels(source).inc();
  }

  recordReconciliationChecked(source: 'endpoint' | 'job', entries: number): void {
    this.reconChecked.labels(source).inc(entries);
  }

  recordRetentionDeleted(table: string, rows: number): void {
    this.retentionDeleted.labels(table).inc(rows);
  }

  setPoolMetrics(total: number, idle: number, waiting: number): void {
    this.poolTotal.set(total);
    this.poolIdle.set(idle);
    this.poolWaiting.set(waiting);
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
