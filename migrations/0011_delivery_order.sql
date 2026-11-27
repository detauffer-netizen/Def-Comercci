-- Entrega/retirada no checkout e ordem manual dos produtos na vitrine.
-- delivery_fee_cents NULL = loja não oferece entrega pelo catálogo.
ALTER TABLE stores ADD COLUMN delivery_fee_cents INTEGER CHECK (delivery_fee_cents IS NULL OR delivery_fee_cents >= 0);
ALTER TABLE stores ADD COLUMN free_delivery_above_cents INTEGER CHECK (free_delivery_above_cents IS NULL OR free_delivery_above_cents >= 0);
ALTER TABLE stores ADD COLUMN pickup_enabled INTEGER NOT NULL DEFAULT 0 CHECK (pickup_enabled IN (0, 1));
ALTER TABLE orders ADD COLUMN fulfillment TEXT NOT NULL DEFAULT '' CHECK (fulfillment IN ('', 'pickup', 'delivery'));
ALTER TABLE orders ADD COLUMN delivery_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (delivery_fee_cents >= 0);
ALTER TABLE orders ADD COLUMN address TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
