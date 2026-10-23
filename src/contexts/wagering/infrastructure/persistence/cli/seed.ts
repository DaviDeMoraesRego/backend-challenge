import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv } from '../../../../../config/env';
import { uuidv7 } from '../../../../../shared/ids/uuid7';
import { buildOrmConfig } from '../mikro-orm.config';
import { executeSql } from '../sql-session';

/**
 * Seed de desenvolvimento/carga: cria wallets já com a transação OPENING e as duas
 * pernas contábeis, de modo que `balance == Σ ledger` continue válido.
 * Eventos de integração NÃO são emitidos (dado de infraestrutura de teste).
 */
const BATCH = 200;

const argValue = (name: string, fallback: number): number => {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  if (!found) return fallback;
  const parsed = Number(found.slice(prefix.length));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

async function main(): Promise<void> {
  const config = loadEnv();
  const total = argValue('wallets', 20);
  const amount =
    process.argv
      .find((arg) => arg.startsWith('--amount='))
      ?.slice('--amount='.length) ?? '1000000.00';
  const currencies = [...config.currencies];
  if (currencies.length === 0) throw new Error('nenhuma moeda suportada configurada');

  const orm = await MikroORM.init(buildOrmConfig(config.env.DATABASE_URL, 4));

  try {
    const accountIds = new Map<string, string>();
    for (const currency of currencies) {
      const rows = await executeSql<{ id: string }>(
        orm.em.fork(),
        `SELECT id FROM accounts WHERE code = 'OPENING_EQUITY' AND owner = 'system' AND currency = $1`,
        [currency],
      );
      if (rows.length === 0) {
        throw new Error(
          `conta OPENING_EQUITY ausente para ${currency} — rode as migrations`,
        );
      }
      accountIds.set(currency, rows[0].id);
    }

    let created = 0;
    for (let index = 0; index < total; index += BATCH) {
      const slice = Math.min(BATCH, total - index);
      await orm.em.fork().transactional(async (trx) => {
        for (let offset = 0; offset < slice; offset += 1) {
          const currency = currencies[(index + offset) % currencies.length];
          const walletId = uuidv7();
          const playerId = uuidv7();
          const transactionId = uuidv7();
          const journalId = uuidv7();
          const walletEntryId = uuidv7();
          const counterpartyEntryId = uuidv7();
          const accountId = accountIds.get(currency) as string;

          await executeSql(
            trx,
            `INSERT INTO wallets (id, player_id, currency, balance, version)
             VALUES ($1, $2, $3, $4, 2)`,
            [walletId, playerId, currency, amount],
          );
          await executeSql(
            trx,
            `INSERT INTO wager_transactions (
               id, provider_id, external_transaction_id, idempotency_key, payload_hash,
               wallet_id, player_id, currency, round_id, game_id, kind, amount, status,
               resulting_balance_amount, processed_at)
             VALUES ($1, 'system', $2, $3, $4, $5, $6, $7, 'system', 'system',
                     'OPENING', $8, 'PROCESSED', $8, now())`,
            [
              transactionId,
              `opening:${walletId}`,
              `system:opening:${walletId}`,
              `seed-${walletId}`,
              walletId,
              playerId,
              currency,
              amount,
            ],
          );
          await executeSql(
            trx,
            `INSERT INTO journals (id, transaction_id, currency) VALUES ($1, $2, $3)`,
            [journalId, transactionId, currency],
          );
          await executeSql(
            trx,
            `INSERT INTO ledger_entries (
               id, journal_id, transaction_id, wallet_id, account_id, direction, amount,
               currency, balance_before, balance_after, wallet_version)
             VALUES ($1, $2, $3, $4, NULL, 'CREDIT', $5, $6, 0, $5, 2)`,
            [walletEntryId, journalId, transactionId, walletId, amount, currency],
          );
          await executeSql(
            trx,
            `INSERT INTO ledger_entries (
               id, journal_id, transaction_id, wallet_id, account_id, direction, amount,
               currency, balance_before, balance_after, wallet_version)
             VALUES ($1, $2, $3, NULL, $4, 'DEBIT', $5, $6, NULL, NULL, NULL)`,
            [counterpartyEntryId, journalId, transactionId, accountId, amount, currency],
          );
          created += 1;
        }
      });
    }

    console.log(`seed: ${created} wallets criadas (${currencies.join('/')})`);
  } finally {
    await orm.close(true);
  }
}

await main();
