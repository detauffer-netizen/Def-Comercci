-- Def Commerce 2.0: vendas presenciais (PDV) na mesma tabela de pedidos.
-- A venda presencial passa pelos mesmos gatilhos de estoque (pendente →
-- confirmado → concluído, numa única transação): sem mecanismo paralelo.
ALTER TABLE orders ADD COLUMN channel TEXT NOT NULL DEFAULT 'online' CHECK (channel IN ('online', 'pos'));
-- Formas de pagamento registradas (não é processamento financeiro):
-- [{"method":"pix|cash|credit|debit|account","amount_cents":123}]
ALTER TABLE orders ADD COLUMN payments_json TEXT NOT NULL DEFAULT '[]';
-- Valor vendido a prazo que ainda falta receber.
ALTER TABLE orders ADD COLUMN receivable_cents INTEGER NOT NULL DEFAULT 0 CHECK (receivable_cents >= 0);
ALTER TABLE orders ADD COLUMN created_by TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_store_channel ON orders(store_id, channel, created_at);
