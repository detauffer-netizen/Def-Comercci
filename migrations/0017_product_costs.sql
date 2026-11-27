-- Def Commerce 2.0: custo, estoque mínimo e dados de compra dos produtos.
-- Tudo opcional: produtos antigos continuam funcionando sem custo informado.
ALTER TABLE products ADD COLUMN cost_cents INTEGER CHECK (cost_cents IS NULL OR cost_cents >= 0);
ALTER TABLE products ADD COLUMN min_stock INTEGER CHECK (min_stock IS NULL OR min_stock >= 0);
ALTER TABLE products ADD COLUMN barcode TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN supplier TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN location TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN created_at TEXT;
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(store_id, barcode) WHERE barcode <> '';
-- Pedidos passam a guardar o custo de cada item no momento da venda
-- (items_json[].cost_cents), para que mudar o custo depois não altere relatórios antigos.
