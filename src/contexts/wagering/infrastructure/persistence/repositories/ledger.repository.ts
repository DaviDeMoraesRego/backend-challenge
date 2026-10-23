import type { DbSession } from '../../../application/ports/db-session';
import type { LedgerAggregate, LedgerRepository } from '../../../application/ports/repositories';
import type { CounterpartyLedgerEntry } from '../../../domain/ledger/counterparty-ledger-entry';
import type { Journal } from '../../../domain/ledger/journal';
import type { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry';
import { toLedgerAggregate, toWalletLedgerEntry } from '../mappers';
import type { LedgerAggregateRow, LedgerEntryRow } from '../records';

export class MikroLedgerRepository implements LedgerRepository {
  constructor(private readonly session: DbSession) {}

  async insertJournalWithLegs(
    journal: Journal,
    walletEntry: WalletLedgerEntry,
    counterpartyEntry: CounterpartyLedgerEntry,
    counterpartyAccountId: string,
  ): Promise<void> {
    await this.session.query(
      `INSERT INTO journals (id, transaction_id, currency, created_at)
       VALUES ($1, $2, $3, $4)`,
      [journal.id, journal.transactionId, journal.currency, journal.createdAt],
    );

    await this.session.query(
      `INSERT INTO ledger_entries (
         id, journal_id, transaction_id, wallet_id, account_id, direction, amount,
         currency, balance_before, balance_after, wallet_version, created_at)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $11)`,
      [
        walletEntry.id,
        walletEntry.journalId,
        walletEntry.transactionId,
        walletEntry.walletId,
        walletEntry.direction,
        walletEntry.money.toString(),
        walletEntry.money.currency,
        walletEntry.balanceBefore.toString(),
        walletEntry.balanceAfter.toString(),
        walletEntry.walletVersion,
        walletEntry.createdAt,
      ],
    );

    await this.session.query(
      `INSERT INTO ledger_entries (
         id, journal_id, transaction_id, wallet_id, account_id, direction, amount,
         currency, balance_before, balance_after, wallet_version, created_at)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, NULL, NULL, NULL, $8)`,
      [
        counterpartyEntry.id,
        counterpartyEntry.journalId,
        counterpartyEntry.transactionId,
        counterpartyAccountId,
        counterpartyEntry.direction,
        counterpartyEntry.money.toString(),
        counterpartyEntry.money.currency,
        counterpartyEntry.createdAt,
      ],
    );
  }

  async sumByWallet(walletId: string): Promise<LedgerAggregate> {
    const row = await this.session.queryOne<LedgerAggregateRow>(
      `WITH agg AS (
         SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS sum,
                COUNT(*)::int AS entries,
                MAX(currency)::text AS currency
           FROM ledger_entries WHERE wallet_id = $1
       ), last_entry AS (
         SELECT balance_after::text AS last_balance_after,
                wallet_version::text AS last_wallet_version
           FROM ledger_entries WHERE wallet_id = $1
          ORDER BY wallet_version DESC, id DESC LIMIT 1
       )
       SELECT $1::text AS wallet_id, agg.sum, agg.entries, agg.currency,
              last_entry.last_balance_after, last_entry.last_wallet_version
         FROM agg LEFT JOIN last_entry ON true`,
      [walletId],
    );
    return toLedgerAggregate(row ?? undefined);
  }

  async pageByWallet(
    walletId: string,
    cursor: { walletVersion: number; entryId: string } | null,
    limit: number,
  ): Promise<WalletLedgerEntry[]> {
    const rows = cursor
      ? await this.session.query<LedgerEntryRow>(
          `SELECT * FROM ledger_entries
            WHERE wallet_id = $1
              AND (wallet_version, id) > ($2::bigint, $3::uuid)
            ORDER BY wallet_version, id
            LIMIT $4`,
          [walletId, cursor.walletVersion, cursor.entryId, limit],
        )
      : await this.session.query<LedgerEntryRow>(
          `SELECT * FROM ledger_entries
            WHERE wallet_id = $1
            ORDER BY wallet_version, id
            LIMIT $2`,
          [walletId, limit],
        );
    return rows.map(toWalletLedgerEntry);
  }

  async chainCheck(walletId: string): Promise<number> {
    const row = await this.session.queryOne<{ breaks: number }>(
      `SELECT COUNT(*)::int AS breaks FROM (
         SELECT wallet_version, balance_before,
                LAG(balance_after) OVER (PARTITION BY wallet_id ORDER BY wallet_version, id) AS prev
           FROM ledger_entries WHERE wallet_id = $1
       ) t
       WHERE prev IS NOT NULL AND balance_before <> prev`,
      [walletId],
    );
    return Number(row?.breaks ?? 0);
  }

  async aggregateByWallets(
    walletIds: readonly string[],
  ): Promise<Map<string, LedgerAggregate>> {
    const result = new Map<string, LedgerAggregate>();
    if (walletIds.length === 0) return result;
    const rows = await this.session.query<LedgerAggregateRow>(
      `SELECT wallet_id::text AS wallet_id,
              COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS sum,
              COUNT(*)::int AS entries,
              MAX(currency)::text AS currency,
              NULL::text AS last_balance_after,
              NULL::text AS last_wallet_version
         FROM ledger_entries
        WHERE wallet_id IN (SELECT (json_array_elements_text($1::json))::uuid)
        GROUP BY wallet_id`,
      [JSON.stringify([...walletIds])],
    );
    for (const row of rows) {
      result.set(row.wallet_id, toLedgerAggregate(row));
    }
    return result;
  }

  async journalImbalanceByCurrency(): Promise<Array<{ currency: string; net: string }>> {
    return this.session.query<{ currency: string; net: string }>(
      `SELECT j.currency::text AS currency,
              SUM(CASE WHEN e.direction = 'DEBIT' THEN e.amount ELSE -e.amount END)::text AS net
         FROM journals j
         JOIN ledger_entries e ON e.journal_id = j.id
        GROUP BY j.currency
        ORDER BY j.currency`,
    );
  }
}
