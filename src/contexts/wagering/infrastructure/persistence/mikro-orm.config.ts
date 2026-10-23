import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import type { Options } from '@mikro-orm/postgresql';
import { Migration20260101000000_core_tables } from './migrations/Migration20260101000000_core_tables';
import { Migration20260101000001_immutability_triggers } from './migrations/Migration20260101000001_immutability_triggers';
import { Migration20260101000002_deferred_constraints_and_roles } from './migrations/Migration20260101000002_deferred_constraints_and_roles';
import { Migration20260101000003_retention_indexes } from './migrations/Migration20260101000003_retention_indexes';
import { Migration20260101000004_wallet_provider_ownership } from './migrations/Migration20260101000004_wallet_provider_ownership';

export const MIGRATIONS = [
  Migration20260101000000_core_tables,
  Migration20260101000001_immutability_triggers,
  Migration20260101000002_deferred_constraints_and_roles,
  Migration20260101000003_retention_indexes,
  Migration20260101000004_wallet_provider_ownership,
];

/**
 * MikroORM é usado como Unit of Work / pool / migrator (ADR-08 + ADR-14).
 * O mapeamento domínio⇄banco é feito por mappers explícitos sobre SQL parametrizado
 * (registros planos), mantendo o domínio 100% puro e o NUMERIC(19,2) como string.
 */
export function buildOrmConfig(
  clientUrl: string,
  poolMax: number,
  connectTimeoutMs = 5000,
): Options {
  return defineConfig({
    clientUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      migrationsList: MIGRATIONS,
      transactional: true,
      allOrNothing: true,
      emit: 'ts',
    },
    pool: {
      min: 0,
      max: poolMax,
      acquireTimeoutMillis: connectTimeoutMs,
    },
    forceUtcTimezone: true,
    debug: false,
    // contexto global esconde transações vazando entre requisições — sempre `em.fork()`.
    allowGlobalContext: false,
  });
}
