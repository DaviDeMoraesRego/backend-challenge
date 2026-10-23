import type { MikroORM } from '@mikro-orm/core';
import { executeSql } from '../../src/contexts/wagering/infrastructure/persistence/sql-session';

export interface LedgerInvariantsReport {
  readonly balanceMismatches: Array<{ walletId: string; balance: string; derived: string }>;
  readonly chainBreaks: number;
  readonly unbalancedJournals: Array<{ journalId: string; debits: string; credits: string }>;
  readonly mixedCurrencyEntries: number;
  readonly versionMismatches: Array<{ walletId: string; version: string; ledgerVersion: string }>;
  readonly globalImbalances: Array<{ currency: string; net: string }>;
}

/**
 * Invariante final de **todo** teste de integração/concorrência (README §13):
 * wallet.balance == saldo reconstruído pelo ledger, cadeia íntegra e Σ=0.
 */
export async function assertLedgerMatchesBalance(
  orm: MikroORM,
  walletIds: readonly string[],
): Promise<LedgerInvariantsReport> {
  const ids = [...walletIds];
  const em = orm.em.fork();

  const balanceMismatches =
    ids.length === 0
      ? []
      : await executeSql<{ walletId: string; balance: string; derived: string }>(
          em,
          `SELECT w.id::text AS "walletId", w.balance::text AS balance,
                  COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::text AS derived
             FROM wallets w
             LEFT JOIN ledger_entries e ON e.wallet_id = w.id
            WHERE w.id IN (SELECT (json_array_elements_text($1::json))::uuid)
            GROUP BY w.id, w.balance
           HAVING w.balance <> COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0)`,
          [JSON.stringify(ids)],
        );

  const chainRow =
    ids.length === 0
      ? [{ breaks: 0 }]
      : await executeSql<{ breaks: number }>(
          em,
          `SELECT COUNT(*)::int AS breaks FROM (
             SELECT wallet_version, balance_before,
                    LAG(balance_after) OVER (PARTITION BY wallet_id ORDER BY wallet_version, id) AS prev
               FROM ledger_entries WHERE wallet_id IN (SELECT (json_array_elements_text($1::json))::uuid)
           ) t WHERE prev IS NOT NULL AND balance_before <> prev`,
          [JSON.stringify(ids)],
        );

  const unbalancedJournals = await executeSql<{
    journalId: string;
    debits: string;
    credits: string;
  }>(
    em,
    `SELECT j.id::text AS "journalId",
            SUM(e.amount) FILTER (WHERE e.direction = 'DEBIT')::text AS debits,
            SUM(e.amount) FILTER (WHERE e.direction = 'CREDIT')::text AS credits
       FROM journals j
       JOIN ledger_entries e ON e.journal_id = j.id
      GROUP BY j.id
     HAVING SUM(e.amount) FILTER (WHERE e.direction = 'DEBIT')
         <> SUM(e.amount) FILTER (WHERE e.direction = 'CREDIT')`,
  );

  const mixedCurrency = await executeSql<{ count: number }>(
    em,
    `SELECT COUNT(*)::int AS count FROM ledger_entries e
       JOIN journals j ON j.id = e.journal_id
      WHERE e.currency <> j.currency`,
  );

  const versionMismatches =
    ids.length === 0
      ? []
      : await executeSql<{ walletId: string; version: string; ledgerVersion: string }>(
          em,
          `SELECT w.id::text AS "walletId", w.version::text AS version,
                  MAX(e.wallet_version)::text AS "ledgerVersion"
             FROM wallets w
             JOIN ledger_entries e ON e.wallet_id = w.id
            WHERE w.id IN (SELECT (json_array_elements_text($1::json))::uuid)
            GROUP BY w.id, w.version
           HAVING w.version <> MAX(e.wallet_version)`,
          [JSON.stringify(ids)],
        );

  const globalImbalances = await executeSql<{ currency: string; net: string }>(
    em,
    `SELECT j.currency::text AS currency,
            SUM(CASE WHEN e.direction = 'DEBIT' THEN e.amount ELSE -e.amount END)::text AS net
       FROM journals j JOIN ledger_entries e ON e.journal_id = j.id
      GROUP BY j.currency
     HAVING SUM(CASE WHEN e.direction = 'DEBIT' THEN e.amount ELSE -e.amount END) <> 0`,
  );

  const report: LedgerInvariantsReport = {
    balanceMismatches,
    chainBreaks: Number(chainRow[0]?.breaks ?? 0),
    unbalancedJournals,
    mixedCurrencyEntries: Number(mixedCurrency[0]?.count ?? 0),
    versionMismatches,
    globalImbalances,
  };

  const problems: string[] = [];
  if (report.balanceMismatches.length > 0) {
    problems.push(`saldo ≠ ledger: ${JSON.stringify(report.balanceMismatches)}`);
  }
  if (report.chainBreaks > 0) problems.push(`quebras na cadeia: ${report.chainBreaks}`);
  if (report.unbalancedJournals.length > 0) {
    problems.push(`journals desbalanceados: ${JSON.stringify(report.unbalancedJournals)}`);
  }
  if (report.mixedCurrencyEntries > 0) {
    problems.push(`lançamentos com moeda divergente: ${report.mixedCurrencyEntries}`);
  }
  if (report.versionMismatches.length > 0) {
    problems.push(`version ≠ último ledger: ${JSON.stringify(report.versionMismatches)}`);
  }
  if (report.globalImbalances.length > 0) {
    problems.push(`Σ≠0 por moeda: ${JSON.stringify(report.globalImbalances)}`);
  }
  if (problems.length > 0) {
    throw new Error(`invariantes do ledger violadas → ${problems.join(' | ')}`);
  }
  return report;
}

