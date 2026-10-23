import type { DbSession } from '../../../application/ports/db-session';
import type { AccountRepository } from '../../../application/ports/repositories';
import type { AccountRef } from '../../../domain/ledger/account-ref';

export class MikroAccountRepository implements AccountRepository {
  constructor(private readonly session: DbSession) {}

  async findId(ref: AccountRef): Promise<string | null> {
    const row = await this.session.queryOne<{ id: string }>(
      `SELECT id FROM accounts WHERE code = $1 AND owner = $2 AND currency = $3`,
      [ref.code, ref.owner, ref.currency],
    );
    return row?.id ?? null;
  }

  /**
   * Cria a contrapartida na primeira operação do par provider/moeda.
   * INSERT-only (ON CONFLICT DO NOTHING): a linha nunca sofre UPDATE → sem hot row.
   * Um único round-trip: o INSERT e o SELECT da linha existente vão na mesma query.
   */
  async findOrCreateId(ref: AccountRef, id: string): Promise<string> {
    const row = await this.session.queryOne<{ id: string }>(
      `WITH inserted AS (
         INSERT INTO accounts (id, code, owner, currency) VALUES ($1, $2, $3, $4)
         ON CONFLICT (code, owner, currency) DO NOTHING
         RETURNING id
       )
       SELECT id FROM inserted
       UNION ALL
       SELECT id FROM accounts WHERE code = $2 AND owner = $3 AND currency = $4
       LIMIT 1`,
      [id, ref.code, ref.owner, ref.currency],
    );
    if (!row) {
      throw new Error(
        `conta de contrapartida não pôde ser criada: ${ref.code}:${ref.owner}:${ref.currency}`,
      );
    }
    return row.id;
  }
}
