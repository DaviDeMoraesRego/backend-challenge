/** Sessão SQL dentro da transação corrente (SQL sempre parametrizado: $1…$n). */
export interface DbSession {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T | null>;
}
