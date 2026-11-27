import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client, createEnv, newMerchant } from "./helpers/env.js";
import { base32Decode, currentStep, totpAt } from "../src/lib/totp.js";
import { hashPassword } from "../src/lib/crypto.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);
const code = (secret, offset = 0) => totpAt(secret, currentStep() + offset);

async function enable2fa(client, password, base = "/api/account/2fa") {
  const setup = await client.post(`${base}/setup`, { password });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  assert.match(setup.data.otpauth, /^otpauth:\/\/totp\/Def%20Commerce%3A.+\?secret=[A-Z2-7]+&issuer=Def%20Commerce/);
  assert.equal(base32Decode(setup.data.secret).length, 20);
  const enabled = await client.post(`${base}/enable`, { code: await code(setup.data.secret) });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  assert.equal(enabled.data.recovery_codes.length, 8);
  return { secret: setup.data.secret, recovery: enabled.data.recovery_codes };
}

describe("verificação em duas etapas", () => {
  test("ativação exige senha e um código válido", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    assert.equal((await m.client.get("/api/account/2fa")).data.enabled, false);
    assert.equal((await m.client.post("/api/account/2fa/setup", { password: "errada-errada" })).status, 400);
    const setup = (await m.client.post("/api/account/2fa/setup", { password: m.password })).data;
    assert.equal((await m.client.post("/api/account/2fa/enable", { code: "000000" })).status, 400);
    const ok = await m.client.post("/api/account/2fa/enable", { code: await code(setup.secret) });
    assert.equal(ok.status, 200);
    assert.deepEqual((await m.client.get("/api/account/2fa")).data, { enabled: true, recovery_codes_left: 8 });
    assert.equal((await m.client.post("/api/account/2fa/setup", { password: m.password })).status, 409);
    assert.equal((await m.client.get("/api/me")).status, 200, "sessão atual continua válida");
  });

  test("login passa a exigir o código; senha sozinha não cria sessão", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const { secret } = await enable2fa(m.client, m.password);
    const c = new Client(env, "198.18.7.1");
    const first = await c.post("/api/login", { email: m.email, password: m.password });
    assert.equal(first.status, 200);
    assert.equal(first.data.two_factor_required, true);
    assert.equal(first.headers.get("Set-Cookie"), null);
    assert.equal((await c.get("/api/me")).status, 401);
    assert.equal((await c.post("/api/login/2fa", { challenge: first.data.challenge, code: "123456" })).status, 400);
    assert.equal((await c.post("/api/login/2fa", { challenge: "forjado", code: await code(secret) })).status, 401);
    const second = await c.post("/api/login/2fa", { challenge: first.data.challenge, code: await code(secret, 1) });
    assert.equal(second.status, 200);
    assert.equal((await c.get("/api/me")).status, 200);
    // O mesmo desafio não serve de novo.
    assert.equal((await c.post("/api/login/2fa", { challenge: first.data.challenge, code: await code(secret, 1) })).status, 401);
  });

  test("um código já usado não é aceito de novo", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const { secret } = await enable2fa(m.client, m.password);
    const reused = await code(secret); // usado na ativação
    const c = new Client(env, "198.18.7.2");
    const ch = (await c.post("/api/login", { email: m.email, password: m.password })).data.challenge;
    assert.equal((await c.post("/api/login/2fa", { challenge: ch, code: reused })).status, 400);
  });

  test("desafio é descartado após 5 códigos errados", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const { secret } = await enable2fa(m.client, m.password);
    const c = new Client(env, "198.18.7.3");
    const ch = (await c.post("/api/login", { email: m.email, password: m.password })).data.challenge;
    for (let i = 0; i < 4; i++) assert.equal((await c.post("/api/login/2fa", { challenge: ch, code: "000000" })).status, 400);
    assert.equal((await c.post("/api/login/2fa", { challenge: ch, code: "000000" })).status, 401);
    assert.equal((await c.post("/api/login/2fa", { challenge: ch, code: await code(secret, 1) })).status, 401);
  });

  test("código de recuperação funciona uma única vez", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const { recovery } = await enable2fa(m.client, m.password);
    const login = async (ip) => {
      const c = new Client(env, ip);
      const ch = (await c.post("/api/login", { email: m.email, password: m.password })).data.challenge;
      return c.post("/api/login/2fa", { challenge: ch, code: recovery[0].toLowerCase() });
    };
    assert.equal((await login("198.18.7.4")).status, 200);
    assert.equal((await login("198.18.7.5")).status, 400);
    assert.equal((await m.client.get("/api/account/2fa")).data.recovery_codes_left, 7);
  });

  test("ativar encerra outras sessões; desativar exige senha e código", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const other = new Client(env, "198.18.7.6");
    await other.post("/api/login", { email: m.email, password: m.password });
    const { secret } = await enable2fa(m.client, m.password);
    assert.equal((await other.get("/api/me")).status, 401);
    assert.equal((await m.client.post("/api/account/2fa/disable", { password: m.password, code: "000000" })).status, 400);
    assert.equal((await m.client.post("/api/account/2fa/disable", { password: "errada-errada", code: await code(secret, 1) })).status, 400);
    assert.equal((await m.client.post("/api/account/2fa/disable", { password: m.password, code: await code(secret, 1) })).status, 200);
    const plain = await new Client(env, "198.18.7.7").post("/api/login", { email: m.email, password: m.password });
    assert.equal(plain.data.ok, true);
  });

  test("super administrador também usa 2FA", async () => {
    const env = createEnv();
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO users(id,email,password_hash) VALUES(?,?,?)").bind(id, "adm2@x.com", await hashPassword("admin-senha-forte")).run();
    await env.DB.prepare("INSERT INTO platform_admins(user_id) VALUES(?)").bind(id).run();
    const admin = new Client(env, "100.64.2.1");
    await admin.post("/api/login", { email: "adm2@x.com", password: "admin-senha-forte" });
    const { secret } = await enable2fa(admin, "admin-senha-forte", "/api/admin/2fa");
    const again = new Client(env, "100.64.2.2");
    const ch = (await again.post("/api/login", { email: "adm2@x.com", password: "admin-senha-forte" })).data.challenge;
    assert.equal((await again.get("/api/admin/me")).status, 401);
    await again.post("/api/login/2fa", { challenge: ch, code: await code(secret, 1) });
    assert.equal((await again.get("/api/admin/me")).status, 200);
  });

  test("excluir loja e remover funcionário funcionam com 2FA e desafios pendentes", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    await m.client.post("/api/team", { name: "F", email: "f7@x.com", password: "provisoria-123", permissions: ["orders"] });
    const staffId = (await m.client.get("/api/team")).data.find((t) => t.email === "f7@x.com").id;
    const staff = new Client(env, "198.18.7.8");
    await staff.post("/api/login", { email: "f7@x.com", password: "provisoria-123" });
    await staff.post("/api/account/password", { current_password: "provisoria-123", new_password: "nova-senha-forte" });
    await enable2fa(staff, "nova-senha-forte");
    await new Client(env, "198.18.7.9").post("/api/login", { email: "f7@x.com", password: "nova-senha-forte" }); // desafio pendente
    assert.equal((await m.client.delete(`/api/team/${staffId}`)).status, 200);
    await enable2fa(m.client, m.password);
    await new Client(env, "198.18.7.10").post("/api/login", { email: m.email, password: m.password }); // desafio pendente
    assert.equal((await m.client.post("/api/account/delete", { password: m.password, confirm_slug: m.slug })).status, 200);
    assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM login_challenges").first()).n, 0);
  });
});

describe("ordem das fotos", () => {
  test("reordena as fotos e a primeira vira a capa na vitrine", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const id = (await m.client.post("/api/products", { name: "Foto", price_cents: 1, stock: 1 })).data.id;
    const up = [];
    for (let i = 0; i < 3; i++) up.push((await m.client.post(`/api/products/${id}/images`, PNG, { raw: true, headers: { "Content-Type": "image/png" } })).data);
    const order = [up[2].id, up[0].id, up[1].id];
    assert.equal((await m.client.request("PUT", `/api/products/${id}/images/order`, { ids: order })).status, 200);
    const shop = (await new Client(env).get(`/api/store/${m.slug}`)).data.products[0];
    assert.deepEqual(shop.images, [up[2].url, up[0].url, up[1].url]);
    assert.equal((await m.client.request("PUT", `/api/products/${id}/images/order`, { ids: [up[0].id] })).status, 400);
    assert.equal((await m.client.request("PUT", `/api/products/${id}/images/order`, { ids: [up[0].id, up[0].id, up[1].id] })).status, 400);
    const other = await newMerchant(env);
    assert.equal((await other.client.request("PUT", `/api/products/${id}/images/order`, { ids: order })).status, 400);
  });
});
