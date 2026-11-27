// Equipe da loja (funcionários com permissões) e troca de senha.

import { HttpError, json, readJson } from "../lib/http.js";
import { hashPassword, verifyPassword } from "../lib/crypto.js";
import { PERMISSIONS, audit, parsePermissions, rateLimit, requireOwner } from "../lib/session.js";
import * as v from "../lib/validate.js";

const MAX_TEAM = 20;

function permissionList(value) {
  if (!Array.isArray(value)) throw new HttpError(400, "Permissões inválidas");
  const list = [...new Set(value)];
  if (list.some((p) => !PERMISSIONS.includes(p))) throw new HttpError(400, "Permissões inválidas");
  return PERMISSIONS.filter((p) => list.includes(p));
}

export async function listTeam(request, env, session) {
  requireOwner(session);
  const rows = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, m.role, m.permissions, u.must_change_password, u.created_at
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.store_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, u.created_at`,
  ).bind(session.store.id).all();
  return json(rows.results.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    permissions: r.role === "owner" ? PERMISSIONS : parsePermissions(r.permissions),
    pending_password: !!r.must_change_password,
    created_at: r.created_at,
    is_me: r.id === session.user.id,
  })));
}

// Sem provedor de e-mail, o proprietário define uma senha provisória e a
// entrega ao funcionário; no primeiro acesso a troca é obrigatória.
export async function addMember(request, env, session) {
  requireOwner(session);
  const db = env.DB;
  const body = await readJson(request);
  const name = v.requiredText(body.name, 100, "o nome do funcionário");
  const email = v.email(body.email);
  const password = v.password(body.password);
  const permissions = permissionList(body.permissions);
  const count = await db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE store_id=?").bind(session.store.id).first();
  if (count.n >= MAX_TEAM) throw new HttpError(409, `Limite de ${MAX_TEAM} pessoas na equipe`);
  const userId = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare("INSERT INTO users(id,email,password_hash,name,must_change_password) VALUES(?,?,?,?,1)")
        .bind(userId, email, await hashPassword(password), name),
      db.prepare("INSERT INTO memberships(user_id,store_id,role,permissions) VALUES(?,?,'staff',?)")
        .bind(userId, session.store.id, permissions.join(",")),
    ]);
  } catch {
    throw new HttpError(409, "Este e-mail já tem uma conta no Def Commerce. Use outro e-mail.");
  }
  await audit(db, { storeId: session.store.id, userId: session.user.id, action: "team.added", target: userId, detail: `${email}: ${permissions.join(",")}` });
  return json({ created: true, id: userId }, 201);
}

async function staffMember(db, session, userId) {
  const id = v.id(userId);
  const row = await db.prepare("SELECT role FROM memberships WHERE user_id=? AND store_id=?").bind(id, session.store.id).first();
  if (!row) throw new HttpError(404, "Funcionário não encontrado");
  if (row.role === "owner") throw new HttpError(400, "As permissões do proprietário não podem ser alteradas");
  return id;
}

export async function updateMember(request, env, session, params) {
  requireOwner(session);
  const id = await staffMember(env.DB, session, params.id);
  const permissions = permissionList((await readJson(request)).permissions);
  await env.DB.prepare("UPDATE memberships SET permissions=? WHERE user_id=? AND store_id=?")
    .bind(permissions.join(","), id, session.store.id).run();
  await audit(env.DB, { storeId: session.store.id, userId: session.user.id, action: "team.permissions", target: id, detail: permissions.join(",") });
  return json({ ok: true });
}

export async function removeMember(request, env, session, params) {
  requireOwner(session);
  const db = env.DB;
  const id = await staffMember(db, session, params.id);
  await db.batch([
    db.prepare("DELETE FROM memberships WHERE user_id=? AND store_id=?").bind(id, session.store.id),
    db.prepare("DELETE FROM sessions WHERE user_id=?").bind(id),
  ]);
  // Remove a conta se ela não pertence a mais nenhuma loja nem à administração.
  await db.prepare(
    `DELETE FROM users WHERE id=? AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id=?)
        AND NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_id=?)`,
  ).bind(id, id, id).run();
  await audit(db, { storeId: session.store.id, userId: session.user.id, action: "team.removed", target: id });
  return json({ ok: true });
}

// Troca de senha de qualquer usuário autenticado. Encerra as outras sessões.
export async function changePassword(request, env, session) {
  const db = env.DB;
  await rateLimit(db, "password-change", session.user.id, 10);
  const body = await readJson(request);
  const user = await db.prepare("SELECT password_hash FROM users WHERE id=?").bind(session.user.id).first();
  const current = String(body.current_password ?? "").slice(0, 128);
  if (!(await verifyPassword(current, user?.password_hash))) throw new HttpError(400, "A senha atual está incorreta");
  const next = v.password(body.new_password);
  if (next === current) throw new HttpError(400, "A nova senha deve ser diferente da atual");
  await db.batch([
    db.prepare("UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?").bind(await hashPassword(next), session.user.id),
    db.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?").bind(session.user.id, session.tokenHash),
  ]);
  await audit(db, { storeId: session.store?.id ?? null, userId: session.user.id, action: "user.password_changed" });
  return json({ ok: true });
}
