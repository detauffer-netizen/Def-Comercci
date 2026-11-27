-- Def Commerce 2.0: movimentações manuais de estoque e fornecedores.

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_store_name ON suppliers(store_id, name COLLATE NOCASE);

-- Entradas (compras), perdas, ajustes e contagens de inventário.
-- O estoque muda pelo gatilho abaixo, na mesma instrução do registro:
-- se o resultado ficaria negativo, o CHECK do produto/variação desfaz tudo.
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  product_id TEXT NOT NULL,
  variant_id TEXT,
  product_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('entry', 'loss', 'adjust', 'count')),
  delta INTEGER NOT NULL CHECK (delta <> 0 OR kind = 'count'),
  stock_after INTEGER,
  unit_cost_cents INTEGER CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  supplier TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stock_adjustments_store ON stock_adjustments(store_id, created_at);

CREATE TRIGGER IF NOT EXISTS stock_adjustment_guard BEFORE INSERT ON stock_adjustments
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM products WHERE id = NEW.product_id AND store_id = NEW.store_id)
    THEN RAISE(ABORT, 'Produto não encontrado') END;
  -- Produto com variações: a movimentação é sempre de uma variação.
  SELECT CASE WHEN NEW.variant_id IS NULL AND EXISTS (SELECT 1 FROM product_variants WHERE product_id = NEW.product_id)
    THEN RAISE(ABORT, 'Escolha a variação') END;
  SELECT CASE WHEN NEW.variant_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM product_variants WHERE id = NEW.variant_id AND product_id = NEW.product_id AND store_id = NEW.store_id)
    THEN RAISE(ABORT, 'Variação não encontrada') END;
END;

CREATE TRIGGER IF NOT EXISTS stock_adjustment_apply AFTER INSERT ON stock_adjustments
BEGIN
  UPDATE product_variants SET stock = stock + NEW.delta
   WHERE NEW.variant_id IS NOT NULL AND id = NEW.variant_id AND store_id = NEW.store_id;
  UPDATE products SET stock = stock + NEW.delta
   WHERE NEW.variant_id IS NULL AND id = NEW.product_id AND store_id = NEW.store_id;
  UPDATE stock_adjustments SET stock_after = COALESCE(
      (SELECT stock FROM product_variants WHERE id = NEW.variant_id),
      (SELECT stock FROM products WHERE id = NEW.product_id))
   WHERE id = NEW.id;
END;
