import type { IntegrationEvent } from '../events/integration-event';

export interface TraceContext {
  readonly traceparent: string;
  readonly tracestate?: string;
}

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly publishedAt?: Date;
  readonly traceContext?: TraceContext;
}

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 300_000;
const POISON_DELAY_MS = 24 * 60 * 60 * 1_000;
/** default alinhado a `OUTBOX_MAX_ATTEMPTS` (fonte única em config/env). */
export const OUTBOX_DEFAULT_MAX_ATTEMPTS = 25;

/**
 * Evento pendente de publicação (ADR-05). A linha é a única existência física do
 * evento até o publisher confirmar — nunca há publicação antes do commit.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt?: Date,
    public readonly traceContext?: TraceContext,
  ) {}

  /**
   * Identidade e tempo vêm de fora (`IdGenerator`/`Clock` do chamador): o agregado
   * não gera UUID nem lê o relógio do sistema — mantém determinismo em teste.
   */
  static enqueue(
    event: IntegrationEvent<unknown>,
    deps: { id: string; now: Date; traceContext?: TraceContext | null },
  ): OutboxMessage {
    return new OutboxMessage(
      deps.id,
      event.aggregateId,
      event.eventType,
      event.toJSON() as Record<string, unknown>,
      event.occurredAt,
      0,
      deps.now,
      undefined,
      deps.traceContext ?? undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.traceContext,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  /** Evento envenenado: sai do loop quente e fica para operação manual. */
  isPoisoned(maxAttempts: number): boolean {
    return this._attempts >= maxAttempts;
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
  }

  /** incrementa attempts e calcula o próximo nextAttemptAt (backoff + jitter). */
  scheduleRetry(
    now: Date,
    options: { maxAttempts?: number; jitterMs?: number } = {},
  ): void {
    const maxAttempts = options.maxAttempts ?? OUTBOX_DEFAULT_MAX_ATTEMPTS;
    this._attempts += 1;
    if (this._attempts >= maxAttempts) {
      this._nextAttemptAt = new Date(now.getTime() + POISON_DELAY_MS);
      return;
    }
    const exponential = Math.min(
      MAX_BACKOFF_MS,
      BASE_BACKOFF_MS * 2 ** Math.min(this._attempts, 9),
    );
    const jitterCeiling = options.jitterMs ?? 500;
    const jitter = Math.floor(Math.random() * (jitterCeiling + 1));
    this._nextAttemptAt = new Date(now.getTime() + exponential + jitter);
  }
}
