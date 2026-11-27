-- Cupons de desconto por loja e registro de erros do servidor.

CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  code TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('percent', 'fixed')),
  value INTEGER NOT NULL CHECK (value > 0),
  min_order_cents INTEGER NOT NULL DEFAULT 0 CHECK (min_order_cents >= 0),
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (kind <> 'percent' OR value <= 90)
);
CREATE UNIQUE INDEX IF NOT EXISTS coupons_store_code ON coupons(store_id, code);

-- Pedidos guardam o cupom aplicado. total_cents continua sendo o valor final.
ALTER TABLE orders ADD COLUMN subtotal_cents INTEGER;
ALTER TABLE orders ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0);
ALTER TABLE orders ADD COLUMN coupon_code TEXT NOT NULL DEFAULT '';

-- Erros inesperados do Worker, sem dados pessoais (caminhos com números longos são mascarados).
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS error_log_created ON error_log(created_at);
