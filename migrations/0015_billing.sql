-- Monetização: planos, assinaturas das lojas e pagamentos (Mercado Pago).
-- Nenhum preço comercial é definido aqui: os planos pagos são criados pelo
-- proprietário da plataforma na administração.

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  trial_days INTEGER NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 90),
  -- Limites (NULL = sem limite): max_products, max_team, ai_daily.
  max_products INTEGER CHECK (max_products IS NULL OR max_products >= 0),
  max_team INTEGER CHECK (max_team IS NULL OR max_team >= 1),
  ai_daily INTEGER CHECK (ai_daily IS NULL OR ai_daily >= 0),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Plano gratuito do período beta: é o plano de quem não assinou nada e para
-- onde a loja volta quando uma assinatura paga termina.
INSERT OR IGNORE INTO plans(id,name,description,price_cents,is_default,position)
VALUES ('beta','Beta gratuito','Todos os recursos liberados durante a fase beta.',0,1,0);

CREATE TABLE IF NOT EXISTS subscriptions (
  store_id TEXT PRIMARY KEY REFERENCES stores(id),
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL CHECK (status IN ('pending','trialing','active','past_due','canceled')),
  provider TEXT NOT NULL DEFAULT '',
  provider_id TEXT NOT NULL DEFAULT '',
  pending_plan_id TEXT,
  pending_provider_id TEXT NOT NULL DEFAULT '',
  current_period_end TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Pagamentos recebidos (idempotente pelo id do provedor).
CREATE TABLE IF NOT EXISTS billing_payments (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  plan_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS billing_payments_store ON billing_payments(store_id, created_at);

-- Notificações recebidas (evita processar a mesma duas vezes).
CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
