-- Executar UMA ÚNICA VEZ no D1 de produção, antes do primeiro
-- `wrangler d1 migrations apply --remote`.
--
-- Motivo: as migrações 0001 a 0006 foram aplicadas manualmente em produção,
-- sem a tabela de controle do Wrangler. Sem este registro, o Wrangler tentaria
-- reaplicar 0002 (ALTER TABLE) e falharia com "duplicate column".
--
--   npx wrangler d1 execute def-commerce-db --remote --file=scripts/bootstrap-d1-migrations.sql
--
-- Estado verificado em 27/11/2026: as tabelas e colunas de 0001–0006 existem
-- em produção e não há tabela d1_migrations.
CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO d1_migrations(name) VALUES
  ('0001_initial.sql'),
  ('0002_catalog.sql'),
  ('0003_orders.sql'),
  ('0004_rate_limits.sql'),
  ('0005_stock.sql'),
  ('0006_customers.sql');
