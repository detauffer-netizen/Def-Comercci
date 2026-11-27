-- Def Commerce 2.0: financeiro simplificado.

-- Recebimentos de vendas a prazo (baixa parcial ou total do valor a receber).
CREATE TABLE IF NOT EXISTS receivable_payments (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_receivable_payments_store ON receivable_payments(store_id, created_at);

-- Despesas registradas pelo lojista (aluguel, embalagem, frete...).
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  paid_on TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_store ON expenses(store_id, paid_on);

-- Devoluções de vendas concluídas (parciais ou totais).
-- value_cents = valor dos itens devolvidos (com o desconto rateado);
-- credit_cents = parte abatida do valor a receber; refund_cents = devolvido ao cliente.
CREATE TABLE IF NOT EXISTS order_returns (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  items_json TEXT NOT NULL,
  value_cents INTEGER NOT NULL CHECK (value_cents >= 0),
  value_with_cost_cents INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  refund_cents INTEGER NOT NULL DEFAULT 0 CHECK (refund_cents >= 0),
  credit_cents INTEGER NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  restock INTEGER NOT NULL DEFAULT 1 CHECK (restock IN (0, 1)),
  reason TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_order_returns_store ON order_returns(store_id, created_at);
CREATE INDEX IF NOT EXISTS idx_order_returns_order ON order_returns(order_id);

-- Garantia no banco: só vendas concluídas e nunca mais do que foi vendido,
-- mesmo com duas devoluções ao mesmo tempo.
CREATE TRIGGER IF NOT EXISTS order_return_guard BEFORE INSERT ON order_returns
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM orders o WHERE o.id = NEW.order_id AND o.store_id = NEW.store_id AND o.status = 'completed'
  ) THEN RAISE(ABORT, 'Devolução inválida') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.items_json) r
     WHERE json_extract(r.value, '$.quantity') <= 0
        OR json_extract(r.value, '$.quantity') + COALESCE((
             SELECT SUM(json_extract(x.value, '$.quantity')) FROM order_returns pr, json_each(pr.items_json) x
              WHERE pr.order_id = NEW.order_id
                AND json_extract(x.value, '$.id') = json_extract(r.value, '$.id')
                AND COALESCE(json_extract(x.value, '$.variant_id'), '') = COALESCE(json_extract(r.value, '$.variant_id'), '')), 0)
           > COALESCE((
             SELECT SUM(json_extract(s.value, '$.quantity')) FROM orders o, json_each(o.items_json) s
              WHERE o.id = NEW.order_id
                AND json_extract(s.value, '$.id') = json_extract(r.value, '$.id')
                AND COALESCE(json_extract(s.value, '$.variant_id'), '') = COALESCE(json_extract(r.value, '$.variant_id'), '')), 0)
  ) THEN RAISE(ABORT, 'Quantidade devolvida maior que a vendida') END;
END;

-- Itens devolvidos voltam ao estoque (quando o lojista marca essa opção).
CREATE TRIGGER IF NOT EXISTS order_return_restock AFTER INSERT ON order_returns WHEN NEW.restock = 1
BEGIN
  UPDATE product_variants
     SET stock = stock + (SELECT SUM(json_extract(j.value, '$.quantity')) FROM json_each(NEW.items_json) j
                           WHERE json_extract(j.value, '$.variant_id') = product_variants.id)
   WHERE store_id = NEW.store_id
     AND id IN (SELECT json_extract(value, '$.variant_id') FROM json_each(NEW.items_json));
  UPDATE products
     SET stock = stock + (SELECT SUM(json_extract(j.value, '$.quantity')) FROM json_each(NEW.items_json) j
                           WHERE json_extract(j.value, '$.id') = products.id AND json_extract(j.value, '$.variant_id') IS NULL)
   WHERE store_id = NEW.store_id
     AND id IN (SELECT json_extract(value, '$.id') FROM json_each(NEW.items_json) WHERE json_extract(value, '$.variant_id') IS NULL)
     AND NOT EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = products.id);
END;
