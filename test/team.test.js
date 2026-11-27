import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client, createEnv, newMerchant } from "./helpers/env.js";

const TEMP = "provisoria-123";

async function addStaff(owner, permissions, email = "func@exemplo.com") {
  const res = await owner.post("/api/team", { name: "Funcionária", email, password: TEMP, permissions });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.id;
}

async function staffLogin(env, email = "func@exemplo.com", password = TEMP, ip = "198.18.0.1") {
  const c = new Client(env, ip);
  assert.equal((await c.post("/api/login", { email, password })).status, 200);
  return c;
}

async function activate(c) {
  const res = await c.post("/api/account/password", { current_password: TEMP, new_password: "nova-senha-segura" });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}

describe("equipe e permissões", () => {
  test("proprietário adiciona funcionário que precisa trocar a senha no primeiro acesso", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    await addStaff(m.client, ["orders"]);
    const staff = await staffLogin(env);
    const me = (await staff.get("/api/me")).data;
    assert.equal(me.user.role, "staff");
    assert.equal(me.user.must_change_password, true);
    assert.deepEqual(me.user.permissions, ["orders"]);
    assert.equal(me.store.slug, m.slug);
    assert.equal((await staff.get("/api/orders")).status, 403, "bloqueado até trocar a senha");
    await activate(staff);
    assert.equal((await staff.get("/api/orders")).status, 200);
    assert.equal((await staff.get("/api/me")).data.user.must_change_password, false);
  });

  test("permissões limitam cada área do painel", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    await addStaff(m.client, ["products"]);
    const staff = await staffLogin(env);
    await activate(staff);
    assert.equal((await staff.get("/api/products")).status, 200);
    assert.equal((await staff.post("/api/products", { name: "X", price_cents: 1, stock: 1 })).status, 201);
    assert.equal((await staff.get("/api/orders")).status, 403);
    assert.equal((await staff.get("/api/customers")).status, 403);
    assert.equal((await staff.get("/api/metrics")).status, 403);
    assert.equal((await staff.patch("/api/settings", { accent: "#000000" })).status, 403);
    assert.equal((await staff.get("/api/team")).status, 403);
    assert.equal((await staff.get("/api/audit-log")).status, 403);
    assert.equal((await staff.post("/api/team", { name: "B", email: "b@x.com", password: TEMP, permissions: [] })).status, 403);
  });

  test("proprietário altera permissões e remove o funcionário", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const id = await addStaff(m.client, ["products"]);
    const staff = await staffLogin(env);
    await activate(staff);
    assert.equal((await m.client.patch(`/api/team/${id}`, { permissions: ["orders", "reports"] })).status, 200);
    assert.equal((await staff.get("/api/orders")).status, 200);
    assert.equal((await staff.get("/api/products")).status, 403);
    assert.equal((await m.client.patch(`/api/team/${id}`, { permissions: ["admin"] })).status, 400);
    const team = (await m.client.get("/api/team")).data;
    assert.deepEqual(team.map((t) => t.role), ["owner", "staff"]);
    assert.equal((await m.client.delete(`/api/team/${id}`)).status, 200);
    assert.equal((await staff.get("/api/me")).status, 401, "sessão do removido é encerrada");
    assert.equal((await new Client(env, "198.18.0.9").post("/api/login", { email: "func@exemplo.com", password: "nova-senha-segura" })).status, 401);
  });

  test("proprietário não pode ser alterado nem removido pela rota de equipe", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const ownerId = (await m.client.get("/api/team")).data[0].id;
    assert.equal((await m.client.patch(`/api/team/${ownerId}`, { permissions: [] })).status, 400);
    assert.equal((await m.client.delete(`/api/team/${ownerId}`)).status, 400);
  });

  test("uma loja não vê nem altera a equipe de outra", async () => {
    const env = createEnv();
    const a = await newMerchant(env);
    const b = await newMerchant(env);
    const id = await addStaff(a.client, ["orders"]);
    assert.equal((await b.client.get("/api/team")).data.length, 1);
    assert.equal((await b.client.patch(`/api/team/${id}`, { permissions: ["products"] })).status, 404);
    assert.equal((await b.client.delete(`/api/team/${id}`)).status, 404);
    const staff = await staffLogin(env);
    await activate(staff);
    // Funcionário da loja A só enxerga dados da loja A.
    await b.client.post("/api/products", { name: "Da B", price_cents: 1, stock: 1 });
    await a.client.patch(`/api/team/${id}`, { permissions: ["products"] });
    assert.deepEqual((await staff.get("/api/products")).data, []);
  });

  test("e-mail já cadastrado não pode ser adicionado", async () => {
    const env = createEnv();
    const a = await newMerchant(env);
    const b = await newMerchant(env);
    const res = await a.client.post("/api/team", { name: "X", email: b.email, password: TEMP, permissions: [] });
    assert.equal(res.status, 409);
  });

  test("troca de senha exige a senha atual e encerra outras sessões", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const other = new Client(env, "198.18.0.20");
    await other.post("/api/login", { email: m.email, password: m.password });
    assert.equal((await m.client.post("/api/account/password", { current_password: "errada-errada", new_password: "outra-senha-forte" })).status, 400);
    assert.equal((await m.client.post("/api/account/password", { current_password: m.password, new_password: "curta" })).status, 400);
    assert.equal((await m.client.post("/api/account/password", { current_password: m.password, new_password: m.password })).status, 400);
    assert.equal((await m.client.post("/api/account/password", { current_password: m.password, new_password: "outra-senha-forte" })).status, 200);
    assert.equal((await m.client.get("/api/me")).status, 200, "sessão atual continua");
    assert.equal((await other.get("/api/me")).status, 401, "outras sessões encerradas");
    assert.equal((await new Client(env, "198.18.0.21").post("/api/login", { email: m.email, password: "outra-senha-forte" })).status, 200);
  });
});
