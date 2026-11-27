-- Def Commerce 2.0: vitrine premium e acompanhamento do pedido.
ALTER TABLE stores ADD COLUMN template TEXT NOT NULL DEFAULT 'geral';
-- Horário semanal: [{"d":0-6 (0 = domingo),"open":"09:00","close":"18:00"}]
ALTER TABLE stores ADD COLUMN hours_json TEXT NOT NULL DEFAULT '';
-- Faixa de aviso no topo da vitrine (ex.: "Frete grátis acima de R$ 150").
ALTER TABLE stores ADD COLUMN announcement TEXT NOT NULL DEFAULT '';
-- Código secreto da página pública de acompanhamento do pedido.
ALTER TABLE orders ADD COLUMN public_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_public_token ON orders(public_token) WHERE public_token IS NOT NULL;
