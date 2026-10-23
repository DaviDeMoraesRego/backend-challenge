import type { DbSession } from '../../../application/ports/db-session';
import type {
  InsertOutcome,
  PendingReferenceClaim,
  WagerTransactionRepository,
} from '../../../application/ports/repositories';
import type { WagerTransaction } from '../../../domain/transaction/wager-transaction';
import { WagerTransactionKind } from '../../../domain/transaction/wager-transaction-kind';
import { asDate, toWagerTransaction } from '../mappers';
import type { PendingClaimRow, WagerTransactionRow } from '../records';

export class MikroWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly session: DbSession) {}

  /**
   * Claim de idempotência: `ON CONFLICT DO NOTHING` **sem** target cobre o único de
   * idempotency_key e o de (provider, external). O índice único bloqueia duplicatas
   * concorrentes até o commit do primeiro inserter (ADR-03/ADR-04).
   */
  async insertPending(tx: WagerTransaction): Promise<InsertOutcome> {
    const rows = await this.session.query<{ id: string }>(
      `INSERT INTO wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, currency, round_id, game_id, kind, amount, status,
         reference_external_transaction_id, reference_transaction_id, failure_code,
         resulting_balance_amount, processed_at, attempts, next_attempt_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        tx.id,
        tx.providerId,
        tx.externalTransactionId,
        tx.idempotencyKey,
        tx.payloadHash,
        tx.walletId,
        tx.playerId,
        tx.money.currency,
        tx.roundId,
        tx.gameId,
        tx.kind,
        tx.money.toString(),
        tx.status,
        tx.referenceExternalTransactionId ?? null,
        tx.referenceTransactionId ?? null,
        tx.failureCode ?? null,
        tx.resultingBalance ? tx.resultingBalance.toString() : null,
        tx.processedAt ?? null,
        tx.attempts,
        tx.nextAttemptAt ?? null,
        tx.createdAt,
      ],
    );
    return rows.length > 0 ? { outcome: 'inserted' } : { outcome: 'conflict' };
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const row = await this.session.queryOne<WagerTransactionRow>(
      `SELECT * FROM wager_transactions WHERE idempotency_key = $1`,
      [key],
    );
    return row ? toWagerTransaction(row) : null;
  }

  async findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const row = await this.session.queryOne<WagerTransactionRow>(
      `SELECT * FROM wager_transactions
       WHERE provider_id = $1 AND external_transaction_id = $2`,
      [providerId, externalTransactionId],
    );
    return row ? toWagerTransaction(row) : null;
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    const row = await this.session.queryOne<WagerTransactionRow>(
      `SELECT * FROM wager_transactions WHERE id = $1`,
      [id],
    );
    return row ? toWagerTransaction(row) : null;
  }

  async findByIdForUpdate(id: string): Promise<WagerTransaction | null> {
    const row = await this.session.queryOne<WagerTransactionRow>(
      `SELECT * FROM wager_transactions WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return row ? toWagerTransaction(row) : null;
  }

  /**
   * Estorno já aplicado. Quando a referência é uma BET, REFUND e ROLLBACK são
   * alternativas do **mesmo** crédito — qualquer um dos dois bloqueia o outro.
   */
  async existsProcessedReversal(
    providerId: string,
    referenceExternalTransactionId: string,
    kind: WagerTransactionKind,
    referenceKind?: WagerTransactionKind,
  ): Promise<boolean> {
    const kinds =
      referenceKind === WagerTransactionKind.Bet
        ? [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]
        : [kind];
    const row = await this.session.queryOne<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM wager_transactions
         WHERE provider_id = $1 AND reference_external_transaction_id = $2
           AND kind::text = ANY(string_to_array($3::text, ','))
           AND status = 'PROCESSED'
       ) AS exists`,
      [providerId, referenceExternalTransactionId, kinds.join(',')],
    );
    return row?.exists === true;
  }

  async finalize(tx: WagerTransaction): Promise<void> {
    await this.session.query(
      `UPDATE wager_transactions
          SET status = $2,
              wallet_id = $3,
              reference_transaction_id = $4,
              failure_code = $5,
              resulting_balance_amount = $6,
              processed_at = $7,
              attempts = $8,
              next_attempt_at = $9
        WHERE id = $1`,
      [
        tx.id,
        tx.status,
        tx.walletId,
        tx.referenceTransactionId ?? null,
        tx.failureCode ?? null,
        tx.resultingBalance ? tx.resultingBalance.toString() : null,
        tx.processedAt ?? null,
        tx.attempts,
        tx.nextAttemptAt ?? null,
      ],
    );
  }

  /** Claim com lease (60s) — SKIP LOCKED garante lotes disjuntos entre instâncias. */
  async claimPendingReference(
    limit: number,
    leaseMs: number,
  ): Promise<PendingReferenceClaim[]> {
    const rows = await this.session.query<PendingClaimRow>(
      `UPDATE wager_transactions
          SET next_attempt_at = now() + (interval '1 millisecond' * $2::int)
        WHERE id IN (
          SELECT id FROM wager_transactions
           WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= now()
           ORDER BY next_attempt_at, id
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, attempts, created_at`,
      [limit, leaseMs],
    );
    return rows.map((row) => ({
      id: row.id,
      attempts: Number(row.attempts),
      createdAt: asDate(row.created_at),
    }));
  }

  async findDependentIds(
    providerId: string,
    referenceExternalTransactionId: string,
  ): Promise<string[]> {
    const rows = await this.session.query<{ id: string }>(
      `SELECT id FROM wager_transactions
        WHERE provider_id = $1 AND reference_external_transaction_id = $2
          AND status = 'PENDING_REFERENCE'
        ORDER BY created_at
        LIMIT 100`,
      [providerId, referenceExternalTransactionId],
    );
    return rows.map((row) => row.id);
  }

  async scheduleNextAttempt(
    id: string,
    attempts: number,
    nextAt: Date,
  ): Promise<void> {
    await this.session.query(
      `UPDATE wager_transactions SET attempts = $2, next_attempt_at = $3 WHERE id = $1`,
      [id, attempts, nextAt],
    );
  }

  async countPendingReference(): Promise<number> {
    const row = await this.session.queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`,
    );
    return Number(row?.count ?? 0);
  }
}
