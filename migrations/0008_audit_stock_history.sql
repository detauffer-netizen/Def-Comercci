-- Trilha de auditoria por loja e histórico automático de movimentações de estoque.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS audit_store ON audit_log(store_id, created_at);

-- Registrado por gatilho, então nenhuma alteração de estoque escapa do
-- histórico, inclusive as feitas pelos gatilhos de pedidos.
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  delta INTEGER NOT NULL,
  stock_after INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS stock_movements_store ON stock_movements(store_id, created_at);

CREATE TRIGGER IF NOT EXISTS product_stock_history_update
AFTER UPDATE OF stock ON products WHEN OLD.stock <> NEW.stock
BEGIN
  INSERT INTO stock_movements(store_id, product_id, product_name, delta, stock_after)
  VALUES (NEW.store_id, NEW.id, NEW.name, NEW.stock - OLD.stock, NEW.stock);
END;

CREATE TRIGGER IF NOT EXISTS product_stock_history_insert
AFTER INSERT ON products WHEN NEW.stock <> 0
BEGIN
  INSERT INTO stock_movements(store_id, product_id, product_name, delta, stock_after)
  VALUES (NEW.store_id, NEW.id, NEW.name, NEW.stock, NEW.stock);
END;
