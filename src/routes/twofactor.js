// Verificação em duas etapas: ativação, desativação e segunda etapa do login.

import { HttpError, json, readJson } from "../lib/http.js";
import { randomToken, sha256, verifyPassword } from "../lib/crypto.js";
import { audit, createSession, rateLimit, rateLimitByIp } from "../lib/session.js";
import { newRecoveryCodes, newSecret, otpauthUri, useRecoveryCode, verifyTotp } from "../lib/totp.js";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const userRow = (db, id) =>
  db.prepare("SELECT id,email,password_hash,totp_secret,totp_enabled,totp_last_step,recovery_codes FROM users WHERE id=?").bind(id).first();

async function requirePassword(user, password) {
  if (!(await verifyPassword(String(password ?? "").slice(0, 128), user.password_hash))) throw new HttpError(400, "Senha incorreta");
}

// Chamada pelo login quando a senha confere e a conta tem 2FA.
export async function createChallenge(db, userId) {
  const token = randomToken(32);
  await db.prepare("DELETE FROM login_challenges WHERE expires_at < ?").bind(Date.now()).run();
  await db.prepare("INSERT INTO login_challenges(token_hash,user_id,expires_at) VALUES(?,?,?)")
    .bind(await sha256(token), userId, Date.now() + CHALLENGE_TTL_MS).run();
  return token;
}

// Confere um código do aplicativo ou de recuperação e grava o uso.
async function consumeSecondFactor(db, user, code) {
  const step = await verifyTotp(user.totp_secret, code, user.totp_last_step);
  if (step !== null) {
    const updated = await db.prepare("UPDATE users SET totp_last_step=? WHERE id=? AND totp_last_step < ?").bind(step, user.id, step).run();
    return updated.meta.changes > 0;
  }
  const remaining = await useRecoveryCode(user.recovery_codes, code);
  if (remaining === null) return false;
  const updated = await db.prepare("UPDATE users SET recovery_codes=? WHERE id=? AND recovery_codes=?").bind(remaining, user.id, user.recovery_codes).run();
  return updated.meta.changes > 0;
}

export async function loginSecondStep(request, env) {
  const db = env.DB;
  await rateLimitByIp(db, request, "login-2fa", 20);
  const body = await readJson(request);
  const tokenHash = await sha256(String(body.challenge ?? ""));
  const challenge = await db.prepare("SELECT user_id,expires_at,attempts FROM login_challenges WHERE token_hash=?").bind(tokenHash).first();
  if (!challenge || challenge.expires_at < Date.now()) throw new HttpError(401, "A verificação expirou. Entre com e-mail e senha novamente.");
  await rateLimit(db, "login-2fa-account", challenge.user_id, 10);
  const user = await userRow(db, challenge.user_id);
  if (!user?.totp_enabled || !(await consumeSecondFactor(db, user, body.code))) {
    if (challenge.attempts + 1 >= 5) {
      await db.prepare("DELETE FROM login_challenges WHERE token_hash=?").bind(tokenHash).run();
      throw new HttpError(401, "Muitas tentativas. Entre com e-mail e senha novamente.");
    }
    await db.prepare("UPDATE login_challenges SET attempts=attempts+1 WHERE token_hash=?").bind(tokenHash).run();
    throw new HttpError(400, "Código inválido. Confira o aplicativo autenticador.");
  }
  await db.prepare("DELETE FROM login_challenges WHERE token_hash=?").bind(tokenHash).run();
  const cookie = await createSession(db, user.id);
  await audit(db, { userId: user.id, action: "user.login", detail: "2FA" });
  return json({ ok: true }, 200, { "Set-Cookie": cookie });
}

export async function status(request, env, session) {
  const user = await userRow(env.DB, session.user.id);
  const remaining = user.recovery_codes ? user.recovery_codes.split(",").length : 0;
  return json({ enabled: !!user.totp_enabled, recovery_codes_left: remaining });
}

export async function setup(request, env, session) {
  const db = env.DB;
  const user = await userRow(db, session.user.id);
  if (user.totp_enabled) throw new HttpError(409, "A verificação em duas etapas já está ativa");
  await requirePassword(user, (await readJson(request)).password);
  const secret = newSecret();
  await db.prepare("UPDATE users SET totp_secret=?, totp_last_step=0 WHERE id=?").bind(secret, user.id).run();
  return json({ secret, otpauth: otpauthUri(secret, user.email) });
}

export async function enable(request, env, session) {
  const db = env.DB;
  await rateLimit(db, "2fa-enable", session.user.id, 10);
  const user = await userRow(db, session.user.id);
  if (user.totp_enabled) throw new HttpError(409, "A verificação em duas etapas já está ativa");
  if (!user.totp_secret) throw new HttpError(400, "Comece a configuração novamente");
  const step = await verifyTotp(user.totp_secret, (await readJson(request)).code, 0);
  if (step === null) throw new HttpError(400, "Código inválido. Confira se o horário do celular está correto.");
  const { codes, stored } = await newRecoveryCodes();
  await db.batch([
    db.prepare("UPDATE users SET totp_enabled=1, totp_last_step=?, recovery_codes=? WHERE id=?").bind(step, stored, user.id),
    // Outras sessões abertas passam a exigir o novo fator.
    db.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?").bind(user.id, session.tokenHash),
  ]);
  await audit(db, { storeId: session.store?.id ?? null, userId: user.id, action: "user.2fa_enabled" });
  return json({ enabled: true, recovery_codes: codes });
}

export async function disable(request, env, session) {
  const db = env.DB;
  await rateLimit(db, "2fa-disable", session.user.id, 10);
  const user = await userRow(db, session.user.id);
  if (!user.totp_enabled) throw new HttpError(409, "A verificação em duas etapas não está ativa");
  const body = await readJson(request);
  await requirePassword(user, body.password);
  if (!(await consumeSecondFactor(db, user, body.code))) throw new HttpError(400, "Código inválido");
  await db.prepare("UPDATE users SET totp_enabled=0, totp_secret='', totp_last_step=0, recovery_codes='' WHERE id=?").bind(user.id).run();
  await audit(db, { storeId: session.store?.id ?? null, userId: user.id, action: "user.2fa_disabled" });
  return json({ enabled: false });
}
