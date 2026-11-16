-- ---------------------------------------------------------------------------
-- Kraken Ges — roles y base de datos PostgreSQL
--
-- Ejecutar como superusuario (postgres) DESPUÉS de cambiar las contraseñas:
--   psql -U postgres -f ops/postgres/roles.sql
--
-- Dos roles:
--   krakenges_migrator: dueño del esquema, solo lo usa drizzle-kit migrate.
--   krakenges_app:      usuario de la aplicación, sin DDL.
-- ---------------------------------------------------------------------------

CREATE ROLE krakenges_migrator LOGIN PASSWORD 'CHANGE_ME_MIGRATOR';
CREATE ROLE krakenges_app LOGIN PASSWORD 'CHANGE_ME_APP';

CREATE DATABASE krakenges
  OWNER krakenges_migrator
  ENCODING 'UTF8'
  LC_COLLATE 'C.UTF-8'
  LC_CTYPE 'C.UTF-8'
  TEMPLATE template0;

REVOKE CONNECT ON DATABASE krakenges FROM PUBLIC;
GRANT CONNECT ON DATABASE krakenges TO krakenges_migrator, krakenges_app;

\connect krakenges

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO krakenges_migrator;
GRANT USAGE ON SCHEMA public TO krakenges_app;

-- Tablas futuras creadas por el migrador: la app recibe DML automáticamente.
ALTER DEFAULT PRIVILEGES FOR ROLE krakenges_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO krakenges_app;
ALTER DEFAULT PRIVILEGES FOR ROLE krakenges_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO krakenges_app;

-- Tablas existentes (si se ejecuta después de migrar).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO krakenges_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO krakenges_app;
