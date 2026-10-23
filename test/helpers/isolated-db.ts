import { SQL } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../../src/contexts/wagering/infrastructure/persistence/mikro-orm.config';
import { TEST_DATABASE_URL, TEST_MIGRATOR_URL } from './infra';

export interface IsolatedDatabase {
  readonly name: string;
  readonly appUrl: string;
  readonly migratorUrl: string;
  migrate(): Promise<void>;
  drop(): Promise<void>;
}

const withDatabase = (url: string, database: string): string => {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
};

/**
 * Banco dedicado por suíte. Necessário porque os 3 processos do compose rodam
 * `outbox-publisher`/`pending-worker` contra o banco principal: sem isolamento, os
 * testes de claim/lease competiriam com eles. Também exercita `migrate up` em base
 * limpa (IT-INFRA-01).
 */
export async function createIsolatedDatabase(prefix: string): Promise<IsolatedDatabase> {
  const name = `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const admin = new SQL(TEST_MIGRATOR_URL);
  try {
    await admin.unsafe(`CREATE DATABASE "${name}" OWNER wagering_migrator`);
  } finally {
    await admin.close();
  }

  const migratorUrl = withDatabase(TEST_MIGRATOR_URL, name);
  const appUrl = withDatabase(TEST_DATABASE_URL, name);

  return {
    name,
    appUrl,
    migratorUrl,
    async migrate(): Promise<void> {
      const orm = await MikroORM.init(buildOrmConfig(migratorUrl, 2));
      try {
        await orm.getMigrator().up();
      } finally {
        await orm.close(true);
      }
    },
    async drop(): Promise<void> {
      const dropper = new SQL(TEST_MIGRATOR_URL);
      try {
        await dropper.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await dropper.close();
      }
    },
  };
}
