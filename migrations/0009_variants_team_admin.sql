-- Variações de produto, equipe com permissões e super administrador.

-- ---------- Equipe ----------
-- Permissões do papel 'staff', separadas por vírgula: products,orders,customers,reports.
-- O papel 'owner' sempre tem todas.
ALTER TABLE memberships ADD COLUMN permissions TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1));

-- ---------- Super administrador ----------
-- Tabela própria, sem relação com memberships: um administrador da plataforma
-- não é membro de loja e o painel do lojista não lhe dá acesso a nada.
CREATE TABLE IF NOT EXISTS platform_admins (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Variações ----------
CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sku TEXT NOT NULL DEFAULT '',
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);
CREATE INDEX IF NOT EXISTS product_variants_product ON product_variants(store_id, product_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS product_variants_store_sku ON product_variants(store_id, sku) WHERE sku <> '';

-- O estoque de um produto com variações é sempre a soma das variações.
CREATE TRIGGER IF NOT EXISTS variant_stock_sync_insert AFTER INSERT ON product_variants
BEGIN
  UPDATE products SET stock = (SELECT COALESCE(SUM(stock), 0) FROM product_variants WHERE product_id = NEW.product_id)
   WHERE id = NEW.product_id;
END;
CREATE TRIGGER IF NOT EXISTS variant_stock_sync_update AFTER UPDATE OF stock ON product_variants
BEGIN
  UPDATE products SET stock = (SELECT COALESCE(SUM(stock), 0) FROM product_variants WHERE product_id = NEW.product_id)
   WHERE id = NEW.product_id;
END;
CREATE TRIGGER IF NOT EXISTS variant_stock_sync_delete AFTER DELETE ON product_variants
BEGIN
  UPDATE products SET stock = (SELECT COALESCE(SUM(stock), 0) FROM product_variants WHERE product_id = OLD.product_id)
   WHERE id = OLD.product_id;
END;

-- Os gatilhos de pedidos passam a entender itens com "variant_id".
-- Itens sem variant_id (pedidos antigos e produtos simples) seguem como antes.
DROP TRIGGER IF EXISTS order_stock_confirm;
CREATE TRIGGER order_stock_confirm BEFORE UPDATE OF status ON orders
WHEN OLD.status = 'pending' AND NEW.status = 'confirmed'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(OLD.items_json) j
      LEFT JOIN products p ON p.id = json_extract(j.value, '$.id') AND p.store_id = OLD.store_id
      LEFT JOIN product_variants v ON v.id = json_extract(j.value, '$.variant_id')
                                  AND v.product_id = p.id AND v.store_id = OLD.store_id
     WHERE p.id IS NULL
        OR (json_extract(j.value, '$.variant_id') IS NULL AND (
              p.stock < json_extract(j.value, '$.quantity')
              OR EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id)))
        OR (json_extract(j.value, '$.variant_id') IS NOT NULL AND (
              v.id IS NULL OR v.stock < json_extract(j.value, '$.quantity')))
  ) THEN RAISE(ABORT, 'Estoque insuficiente ou pedido antigo') END;

  UPDATE product_variants
     SET stock = stock - (SELECT SUM(json_extract(j.value, '$.quantity')) FROM json_each(OLD.items_json) j
                           WHERE json_extract(j.value, '$.variant_id') = product_variants.id)
   WHERE store_id = OLD.store_id
     AND id IN (SELECT json_extract(value, '$.variant_id') FROM json_each(OLD.items_json));

  UPDATE products
     SET stock = stock - (SELECT SUM(json_extract(j.value, '$.quantity')) FROM json_each(OLD.items_json) j
                           WHERE json_extract(j.value, '$.id') = products.id AND json_extract(j.value, '$.variant_id') IS NULL)
   WHERE store_id = OLD.store_id
     AND id IN (SELECT json_extract(value, '$.id') FROM json_each(OLD.items_json) WHERE json_extract(value, '$.variant_id') IS NULL);
END;

DROP TRIGGER IF EXISTS order_stock_cancel;
CREATE TRIGGER order_stock_cancel AFTER UPDATE OF status ON orders
WHEN OLD.status = 'confirmed' AND NEW.status = 'cancelled'
BEGIN
  UPDATE product_variants
     SET stock = stock + (SELECT SUM(json_extract(j.value, '$.quantity')) FROM json_each(OLD.items_json) j
                           WHERE json_extract(j.value, '$.variant_id') = product_variants.id)
   WHERE store_id = OLD.store_id
     AND id IN (SELECT json_extract(value, '$.variant_id') FROM json_each(OLD.items_json));

  UPDATE products
     SET stock = stock + (SELECT SUM(json_extract(j.value, '$.quantity')) FROM json_each(OLD.items_json) j
                           WHERE json_extract(j.value, '$.id') = products.id AND json_extract(j.value, '$.variant_id') IS NULL)
   WHERE store_id = OLD.store_id
     AND id IN (SELECT json_extract(value, '$.id') FROM json_each(OLD.items_json) WHERE json_extract(value, '$.variant_id') IS NULL)
     AND NOT EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = products.id);
END;
