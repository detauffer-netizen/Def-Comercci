-- Consumo de IA por loja e por dia (UTC), para limites e acompanhamento.
CREATE TABLE IF NOT EXISTS ai_usage (
  store_id TEXT NOT NULL REFERENCES stores(id),
  day TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, day)
);
