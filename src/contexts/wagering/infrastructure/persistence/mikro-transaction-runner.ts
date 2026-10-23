import type { EntityManager, MikroORM } from '@mikro-orm/core';
import type { LoggerPort, MetricsPort } from '../../application/ports/misc-ports';
import type {
  RunOptions,
  TransactionRunner,
  UnitOfWork,
} from '../../application/ports/unit-of-work';
import { buildUnitOfWork } from './unit-of-work.factory';
import { executeSql } from './sql-session';
import {
  extractSqlState,
  isLockConflict,
  isTransientSqlState,
} from './sqlstate';

export interface RunnerSettings {
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly idleTxTimeoutMs: number;
  readonly maxRetries: number;
  /** injeção de falhas — proibida em produção pela validação de env. */
  readonly faultInjectionEnabled?: boolean;
  readonly faultDelayLockMs?: number;
}

const BACKOFF_MS = [25, 75, 200];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fronteira transacional: READ COMMITTED + timeouts locais, retry apenas na
 * transação inteira e apenas para SQLSTATE transitório (plans/04 §8.6).
 */
export class MikroTransactionRunner implements TransactionRunner {
  constructor(
    private readonly orm: MikroORM,
    private readonly settings: RunnerSettings,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
  ) {}

  async run<T>(
    work: (uow: UnitOfWork) => Promise<T>,
    options: RunOptions = {},
  ): Promise<T> {
    const maxRetries = options.maxRetries ?? this.settings.maxRetries;
    let attempt = 0;

    for (;;) {
      const em = this.orm.em.fork();
      try {
        return await em.transactional(async (trx: EntityManager) => {
          await this.applyTimeouts(trx);
          await this.applyFaultDelay(trx);
          return work(buildUnitOfWork(trx));
        });
      } catch (error) {
        const sqlstate = extractSqlState(error);
        if (isTransientSqlState(sqlstate) && attempt < maxRetries) {
          attempt += 1;
          this.metrics.recordTransactionRetry(sqlstate as string);
          if (isLockConflict(sqlstate)) {
            this.metrics.recordLockConflict(sqlstate as string);
          }
          this.logger.warn(
            { sqlstate, attempt, maxRetries },
            'transação abortada por erro transitório — retry',
          );
          await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] + Math.random() * 25);
          continue;
        }
        throw error;
      }
    }
  }

  private async applyTimeouts(em: EntityManager): Promise<void> {
    await executeSql(
      em,
      `SELECT set_config('lock_timeout', $1, true),
              set_config('statement_timeout', $2, true),
              set_config('idle_in_transaction_session_timeout', $3, true)`,
      [
        `${this.settings.lockTimeoutMs}ms`,
        `${this.settings.statementTimeoutMs}ms`,
        `${this.settings.idleTxTimeoutMs}ms`,
      ],
    );
  }

  /** FAULT_DELAY_LOCK_MS: abre janela controlada de corrida (CC-02). */
  private async applyFaultDelay(em: EntityManager): Promise<void> {
    const delay = this.settings.faultDelayLockMs ?? 0;
    if (!this.settings.faultInjectionEnabled || delay <= 0) return;
    await executeSql(em, `SELECT pg_sleep($1::double precision / 1000.0)`, [delay]);
  }
}
