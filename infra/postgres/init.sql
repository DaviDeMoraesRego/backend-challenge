-- Bootstrap executado uma única vez pelo entrypoint do container (superuser).
-- A aplicação conecta como wagering_app; migrations rodam como wagering_migrator.
-- Senhas de desenvolvimento — em produção viriam de um secret manager.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wagering_migrator') THEN
    CREATE ROLE wagering_migrator LOGIN PASSWORD 'wagering_migrator';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wagering_app') THEN
    CREATE ROLE wagering_app LOGIN PASSWORD 'wagering_app';
  END IF;
END $$;

-- Os testes de integração criam bancos efêmeros por suíte (isolamento de claim/lease
-- e prova de `migrate up` em base limpa) e simulam queda de conexão (CR-04). Em
-- produção a role não precisa disso.
ALTER ROLE wagering_migrator CREATEDB;
GRANT pg_signal_backend TO wagering_migrator;

ALTER DATABASE wagering OWNER TO wagering_migrator;
GRANT ALL ON SCHEMA public TO wagering_migrator;
GRANT USAGE ON SCHEMA public TO wagering_app;
