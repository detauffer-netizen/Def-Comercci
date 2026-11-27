-- Catálogo profissional: descrição, SKU, preço promocional, destaque,
-- imagens por produto (R2) e identidade visual da loja.
ALTER TABLE products ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN sku TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN promo_price_cents INTEGER CHECK (promo_price_cents IS NULL OR promo_price_cents >= 0);
ALTER TABLE products ADD COLUMN featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1));
CREATE UNIQUE INDEX IF NOT EXISTS products_store_sku ON products(store_id, sku) WHERE sku <> '';

CREATE TABLE IF NOT EXISTS product_images (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS product_images_product ON product_images(store_id, product_id, position);

ALTER TABLE stores ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE stores ADD COLUMN logo_key TEXT NOT NULL DEFAULT '';
ALTER TABLE stores ADD COLUMN banner_key TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN notes TEXT NOT NULL DEFAULT '';
ALTER TABLE stores ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended'));
