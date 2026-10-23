/** Utilitário de verificação: detecta e remove wallets órfãs (sem ledger) e reporta invariantes. */
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../src/contexts/wagering/infrastructure/persistence/mikro-orm.config';
import { executeSql } from '../src/contexts/wagering/infrastructure/persistence/sql-session';

const url =
  process.env.DATABASE_URL_MIGRATOR ??
  'postgres://wagering_migrator:wagering_migrator@localhost:5432/wagering';
const orm = await MikroORM.init(buildOrmConfig(url, 2));

const orphans = await executeSql<{ id: string; balance: string }>(
  orm.em,
  `SELECT w.id::text AS id, w.balance::text AS balance
     FROM wallets w
     LEFT JOIN ledger_entries e ON e.wallet_id = w.id
    WHERE e.id IS NULL`,
);
console.log('wallets sem ledger:', JSON.stringify(orphans));
for (const row of orphans) {
  await executeSql(orm.em, 'DELETE FROM wallets WHERE id = $1', [row.id]);
}

const divergent = await executeSql<{ count: number }>(
  orm.em,
  `SELECT COUNT(*)::int AS count
     FROM wallets w
     JOIN (SELECT wallet_id,
                  SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END) AS s
             FROM ledger_entries GROUP BY wallet_id) l ON l.wallet_id = w.id
    WHERE w.balance <> l.s`,
);

const sigma = await executeSql<{ currency: string; net: string }>(
  orm.em,
  `SELECT j.currency::text AS currency,
          SUM(CASE WHEN e.direction = 'DEBIT' THEN e.amount ELSE -e.amount END)::text AS net
     FROM journals j JOIN ledger_entries e ON e.journal_id = j.id
    GROUP BY j.currency
    ORDER BY j.currency`,
);

const totals = await executeSql<{ wallets: number; entries: number; journals: number }>(
  orm.em,
  `SELECT (SELECT COUNT(*)::int FROM wallets) AS wallets,
          (SELECT COUNT(*)::int FROM ledger_entries) AS entries,
          (SELECT COUNT(*)::int FROM journals) AS journals`,
);

console.log('divergentes saldo≠ledger:', JSON.stringify(divergent));
console.log('Σ=0 por moeda:', JSON.stringify(sigma));
console.log('totais:', JSON.stringify(totals));

await orm.close(true);
