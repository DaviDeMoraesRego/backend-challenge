import type { EntityManager } from '@mikro-orm/core';
import type { DbSession } from '../../application/ports/db-session';

const DOLLAR_PLACEHOLDER = /\$(\d+)/g;

/**
 * O SQL do projeto é escrito com placeholders nomeados posicionalmente (`$1…$n`),
 * mas o driver do MikroORM compila via knex, que usa `?`. A tradução mantém o SQL
 * legível/auditável e parametrizado (jamais interpolação de valores).
 */
export function translatePlaceholders(
  sql: string,
  params: readonly unknown[],
): { sql: string; params: unknown[] } {
  if (params.length === 0) return { sql, params: [] };
  const ordered: unknown[] = [];
  const translated = sql.replace(DOLLAR_PLACEHOLDER, (_match, rawIndex: string) => {
    const position = Number(rawIndex);
    if (!Number.isInteger(position) || position < 1 || position > params.length) {
      throw new Error(`placeholder $${rawIndex} sem parâmetro correspondente`);
    }
    ordered.push(params[position - 1]);
    return '?';
  });
  return { sql: translated, params: ordered };
}

/**
 * Executa SQL parametrizado **no contexto transacional** do EntityManager.
 * `em.execute` (e não `em.getConnection().execute`) é obrigatório: só ele propaga
 * o `transactionContext`, garantindo que o statement participa da tx em curso.
 */
export async function executeSql<T = Record<string, unknown>>(
  em: EntityManager,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const translated = translatePlaceholders(sql, params);
  const rows = await em
    .getConnection()
    .execute(
      translated.sql,
      translated.params as unknown[],
      'all',
      em.getTransactionContext(),
    );
  return (rows ?? []) as T[];
}

/** Adapter de sessão SQL sobre o EntityManager (sempre dentro de uma transação). */
export class MikroDbSession implements DbSession {
  constructor(private readonly em: EntityManager) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    return executeSql<T>(this.em, sql, params);
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }
}
