import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv } from '../../../../../config/env';
import { buildOrmConfig } from '../mikro-orm.config';

const executedMigrations = async (orm: MikroORM): Promise<number> => {
  try {
    const executed = await orm.getMigrator().getExecutedMigrations();
    return executed.length;
  } catch {
    return 0;
  }
};

async function main(): Promise<void> {
  const command = (process.argv[2] ?? 'up').toLowerCase();
  const config = loadEnv();
  const url = config.env.DATABASE_URL_MIGRATOR ?? config.env.DATABASE_URL;

  const orm = await MikroORM.init(buildOrmConfig(url, 2));
  const migrator = orm.getMigrator();

  try {
    switch (command) {
      case 'up': {
        const applied = await migrator.up();
        console.log(
          applied.length === 0
            ? 'migrations: nada a aplicar'
            : `migrations aplicadas: ${applied.map((m) => m.name).join(', ')}`,
        );
        break;
      }
      case 'down': {
        await migrator.down();
        console.log('migration revertida (1 passo)');
        break;
      }
      case 'fresh': {
        let remaining = await executedMigrations(orm);
        while (remaining > 0) {
          await migrator.down();
          remaining = await executedMigrations(orm);
        }
        const applied = await migrator.up();
        console.log(`fresh: ${applied.length} migrations reaplicadas`);
        break;
      }
      case 'status': {
        const count = await executedMigrations(orm);
        console.log(`migrations aplicadas: ${count}`);
        break;
      }
      default:
        throw new Error(`comando desconhecido: ${command} (use up|down|fresh|status)`);
    }
  } finally {
    await orm.close(true);
  }
}

await main();
