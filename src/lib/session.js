// Sessões do painel do lojista, limitação de requisições e auditoria.

import { HttpError, clientIp } from "./http.js";
import { randomToken, sha256 } from "./crypto.js";

// O prefixo __Host- obriga Secure, Path=/ e proíbe Domain: o cookie não pode
// ser definido por subdomínios nem enviado por HTTP sem TLS.
export const SESSION_COOKIE = "__Host-def_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function createSession(db, userId) {
  const token = randomToken(32);
  await db
    .prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
    .bind(await sha256(token), userId, Date.now() + SESSION_TTL_MS)
    .run();
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function readSessionToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)__Host-def_session=([0-9a-f]{64})(?:;|$)/);
  return match ? match[1] : null;
}

// Carrega usuário + loja da sessão. Toda consulta de dados do painel usa o
// store_id retornado aqui; o cliente nunca escolhe a loja.
export async function loadSession(db, request) {
  const token = readSessionToken(request);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await db
    .prepare(
      `SELECT s.token_hash, u.id AS user_id, u.email, m.role,
              st.id AS store_id, st.name, st.slug, st.whatsapp, st.accent,
              st.description, st.logo_key, st.banner_key, st.status
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN memberships m ON m.user_id = u.id
         JOIN stores st ON st.id = m.store_id
        WHERE s.token_hash = ? AND s.expires_at > ?
        ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, st.created_at
        LIMIT 1`,
    )
    .bind(tokenHash, Date.now())
    .first();
  if (!row) return null;
  return {
    tokenHash,
    user: { id: row.user_id, email: row.email, role: row.role },
    store: {
      id: row.store_id,
      name: row.name,
      slug: row.slug,
      whatsapp: row.whatsapp,
      accent: row.accent,
      description: row.description,
      logo_key: row.logo_key,
      banner_key: row.banner_key,
      status: row.status,
    },
  };
}

export function requireOwner(session) {
  if (session.user.role !== "owner") {
    throw new HttpError(403, "Apenas o proprietário da loja pode fazer esta alteração");
  }
}

// Janela fixa de 10 minutos por chave. A chave é um hash, então o IP não
// fica armazenado em texto claro.
export async function rateLimit(db, scope, identity, limit, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const key = await sha256(`${scope}:${identity}:${Math.floor(now / windowMs)}`);
  const row = await db
    .prepare(
      "INSERT INTO rate_limits(key,hits,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1 RETURNING hits",
    )
    .bind(key, now + 2 * windowMs)
    .first();
  if (Math.random() < 0.05) {
    await db.prepare("DELETE FROM rate_limits WHERE expires < ?").bind(now).run();
    await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  }
  if (row.hits > limit) throw new HttpError(429, "Muitas tentativas. Aguarde alguns minutos e tente novamente.");
}

export function rateLimitByIp(db, request, scope, limit) {
  return rateLimit(db, scope, clientIp(request), limit);
}

export async function audit(db, { storeId = null, userId = null, action, target = "", detail = "" }) {
  await db
    .prepare("INSERT INTO audit_log(store_id,user_id,action,target,detail) VALUES(?,?,?,?,?)")
    .bind(storeId, userId, action, String(target).slice(0, 200), String(detail).slice(0, 1000))
    .run();
}
