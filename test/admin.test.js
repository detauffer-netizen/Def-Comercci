import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client, createEnv, newMerchant } from "./helpers/env.js";
import { hashPassword } from "../src/lib/crypto.js";

async function createAdmin(env, email = "admin@defcommerce.com.br", password = "admin-senha-forte") {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users(id,email,password_hash) VALUES(?,?,?)").bind(id, email, await hashPassword(password)).run();
  await env.DB.prepare("INSERT INTO platform_admins(user_id) VALUES(?)").bind(id).run();
  const c = new Client(env, "100.64.0.1");
  assert.equal((await c.post("/api/login", { email, password })).status, 200);
  return c;
}

describe("super administrador", () => {
  test("lojistas e visitantes não acessam a administração", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    for (const path of ["/api/admin/me", "/api/admin/overview", "/api/admin/stores", "/api/admin/audit"]) {
      assert.equal((await m.client.get(path)).status, 401, path);
      assert.equal((await new Client(env).get(path)).status, 401, path);
    }
    const storeId = (await env.DB.prepare("SELECT id FROM stores").first()).id;
    assert.equal((await m.client.patch(`/api/admin/stores/${storeId}`, { status: "suspended", reason: "x" })).status, 401);
  });

  test("administrador não tem acesso ao painel de lojas", async () => {
    const env = createEnv();
    await newMerchant(env);
    const admin = await createAdmin(env);
    assert.equal((await admin.get("/api/me")).status, 401);
    assert.equal((await admin.get("/api/products")).status, 401);
    assert.equal((await admin.get("/api/admin/me")).status, 200);
  });

  test("visão geral e lista de lojas com busca", async () => {
    const env = createEnv();
    const a = await newMerchant(env, { name: "Padaria Central" });
    await newMerchant(env, { name: "Moda Sul" });
    const pid = (await a.client.post("/api/products", { name: "Pão", price_cents: 100, stock: 50 })).data.id;
    const o = (await new Client(env, "192.0.2.80").post(`/api/order-request/${a.slug}`, { customer_name: "C", customer_phone: "54999990000", items: [{ id: pid, quantity: 3 }] })).data;
    await a.client.patch(`/api/orders/${o.id}`, { status: "confirmed" });
    await a.client.patch(`/api/orders/${o.id}`, { status: "completed" });
    const admin = await createAdmin(env);
    const ov = (await admin.get("/api/admin/overview")).data;
    assert.equal(ov.stores, 2);
    assert.equal(ov.active, 2);
    assert.equal(ov.orders, 1);
    assert.equal(ov.gmv, 300);
    const all = (await admin.get("/api/admin/stores")).data;
    assert.equal(all.length, 2);
    const found = (await admin.get("/api/admin/stores?q=padaria")).data;
    assert.deepEqual(found.map((s) => s.name), ["Padaria Central"]);
    assert.equal(found[0].revenue, 300);
    assert.equal(found[0].owner_email, a.email);
    assert.equal((await admin.get("/api/admin/stores?q=%25")).data.length, 0, "curinga escapado");
  });

  test("suspender exige motivo, tira a loja do ar e fica auditado; reativar devolve", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const admin = await createAdmin(env);
    const id = (await admin.get("/api/admin/stores")).data[0].id;
    assert.equal((await admin.patch(`/api/admin/stores/${id}`, { status: "suspended" })).status, 400);
    assert.equal((await admin.patch(`/api/admin/stores/${id}`, { status: "suspended", reason: "Inadimplência" })).status, 200);
    assert.equal((await new Client(env).get(`/api/store/${m.slug}`)).status, 404);
    assert.equal((await m.client.get("/api/products")).status, 403);
    assert.equal((await admin.patch(`/api/admin/stores/${id}`, { status: "active" })).status, 200);
    assert.equal((await new Client(env).get(`/api/store/${m.slug}`)).status, 200);
    const log = (await admin.get("/api/admin/audit")).data.map((r) => r.action);
    assert.ok(log.includes("admin.store_suspended") && log.includes("admin.store_reactivated"));
    assert.equal((await admin.patch(`/api/admin/stores/00000000-0000-0000-0000-000000000000`, { status: "active" })).status, 404);
  });

  test("administrador troca a própria senha e encerra a sessão", async () => {
    const env = createEnv();
    const admin = await createAdmin(env);
    assert.equal((await admin.post("/api/admin/password", { current_password: "admin-senha-forte", new_password: "nova-admin-senha" })).status, 200);
    assert.equal((await admin.post("/api/admin/logout", {})).status, 200);
    assert.equal((await admin.get("/api/admin/me")).status, 401);
  });
});
