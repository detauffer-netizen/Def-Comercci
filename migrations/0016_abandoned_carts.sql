-- Carrinhos abandonados: só existem com o consentimento explícito do comprador
-- ("a loja pode me chamar no WhatsApp se eu não finalizar"). Apagados em 7 dias,
-- ao finalizar o pedido, quando o comprador retira o consentimento ou a pedido dele.
CREATE TABLE IF NOT EXISTS abandoned_carts (
  store_id TEXT NOT NULL REFERENCES stores(id),
  id TEXT NOT NULL,                      -- identificador aleatório gerado no navegador
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  items_json TEXT NOT NULL,
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','contacted','recovered','dismissed')),
  order_id TEXT,
  contacted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (store_id, id)
);
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_store ON abandoned_carts(store_id, status, updated_at);
