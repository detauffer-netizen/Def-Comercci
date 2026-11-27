// Cadastro de lojistas, login e logout.

import { HttpError, json, readJson } from "../lib/http.js";
import { hashPassword, needsRehash, verifyPassword } from "../lib/crypto.js";
import { audit, clearSessionCookie, createSession, rateLimit, rateLimitByIp } from "../lib/session.js";
import * as v from "../lib/validate.js";
import { createChallenge } from "./twofactor.js";

export async function register(request, env) {
  const db = env.DB;
  await rateLimitByIp(db, request, "register", 5);
  const body = await readJson(request);
  const name = v.requiredText(body.name, 100, "o nome da loja");
  const slug = v.slug(body.slug);
  const email = v.email(body.email);
  const password = v.password(body.password);
  const userId = crypto.randomUUID();
  const storeId = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare("INSERT INTO users(id,email,password_hash) VALUES(?,?,?)").bind(userId, email, await hashPassword(password)),
      db.prepare("INSERT INTO stores(id,slug,name) VALUES(?,?,?)").bind(storeId, slug, name),
      db.prepare("INSERT INTO memberships(user_id,store_id,role) VALUES(?,?,'owner')").bind(userId, storeId),
    ]);
  } catch {
    // Mensagem genérica: não confirmamos se o e-mail já está cadastrado.
    throw new HttpError(409, "Não foi possível cadastrar. Verifique o e-mail ou escolha outro endereço para a loja.");
  }
  await audit(db, { storeId, userId, action: "store.created", target: slug });
  const cookie = await createSession(db, userId);
  return json({ created: true, slug }, 201, { "Set-Cookie": cookie });
}

export async function login(request, env) {
  const db = env.DB;
  await rateLimitByIp(db, request, "login", 20);
  const body = await readJson(request);
  const email = String(body.email ?? "").trim().toLowerCase().slice(0, 254);
  const password = String(body.password ?? "");
  // Limite também por conta, contra tentativas distribuídas em vários IPs.
  await rateLimit(db, "login-account", email, 10);
  const user = password.length <= 128
    ? await db.prepare("SELECT id,password_hash,totp_enabled FROM users WHERE email=?").bind(email).first()
    : null;
  const ok = await verifyPassword(password.slice(0, 128), user?.password_hash);
  if (!user || !ok) throw new HttpError(401, "E-mail ou senha incorretos");
  if (needsRehash(user.password_hash)) {
    await db.prepare("UPDATE users SET password_hash=? WHERE id=?").bind(await hashPassword(password), user.id).run();
  }
  // Com 2FA ativo, a senha só libera a segunda etapa (nenhuma sessão ainda).
  if (user.totp_enabled) return json({ two_factor_required: true, challenge: await createChallenge(db, user.id) });
  const cookie = await createSession(db, user.id);
  await audit(db, { userId: user.id, action: "user.login" });
  return json({ ok: true }, 200, { "Set-Cookie": cookie });
}

export async function logout(request, env, session) {
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(session.tokenHash).run();
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}
