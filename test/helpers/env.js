// Ambiente de teste: D1 sobre o SQLite nativo do Node (node:sqlite), R2 em
// memória e ASSETS lendo a pasta public/. Aplica as migrações reais.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import worker from "../../src/index.js";

const ROOT = new URL("../../", import.meta.url).pathname;

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params.map((p) => (p === undefined ? null : typeof p === "boolean" ? Number(p) : p)));
  }
  async first(column) {
    const row = this.db.prepare(this.sql).get(...this.params);
    if (!row) return null;
    const plain = { ...row };
    return column ? plain[column] : plain;
  }
  async all() {
    return { success: true, results: this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...r })), meta: {} };
  }
  async run() {
    if (/\bRETURNING\b/i.test(this.sql)) {
      const rows = this.db.prepare(this.sql).all(...this.params);
      return { success: true, results: rows, meta: { changes: rows.length } };
    }
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
  runSync() {
    return this.db.prepare(this.sql).run(...this.params);
  }
}

export class TestD1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec("PRAGMA foreign_keys = ON");
  }
  prepare(sql) {
    return new Statement(this.db, sql);
  }
  async batch(statements) {
    this.db.exec("BEGIN");
    try {
      const results = [];
      for (const s of statements) results.push(await s.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async exec(sql) {
    this.db.exec(sql);
  }
}

export function migrate(d1) {
  const dir = join(ROOT, "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    d1.db.exec(readFileSync(join(dir, file), "utf8"));
  }
}

class MemoryR2 {
  constructor() {
    this.objects = new Map();
  }
  async put(key, value, options = {}) {
    this.objects.set(key, { bytes: new Uint8Array(value), httpMetadata: options.httpMetadata || {} });
  }
  async get(key) {
    const o = this.objects.get(key);
    if (!o) return null;
    return { body: o.bytes, httpMetadata: o.httpMetadata, httpEtag: `"${key.length}"`, writeHttpMetadata() {} };
  }
  async delete(keys) {
    for (const k of [].concat(keys)) this.objects.delete(k);
  }
}

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json", ".png": "image/png" };

const assets = {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = join(ROOT, "public", path);
    if (!file.startsWith(join(ROOT, "public")) || !existsSync(file)) return new Response("Not found", { status: 404 });
    return new Response(readFileSync(file), { headers: { "Content-Type": TYPES[extname(file)] || "application/octet-stream" } });
  },
};

// IA simulada para testes: devolve o que a função "respond" decidir e
// registra as chamadas. Os testes verificam o NOSSO código, não o modelo.
export function fakeAI(respond) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      return respond(model, input);
    },
  };
}

export function createEnv({ images = true, ai = null, vars = {} } = {}) {
  const DB = new TestD1();
  migrate(DB);
  return { DB, ASSETS: assets, ...(images ? { IMAGES: new MemoryR2() } : {}), ...(ai ? { AI: ai } : {}), ...vars };
}

export const ORIGIN = "https://def-commerce.test";

// Cliente HTTP de teste que guarda o cookie de sessão, como um navegador.
export class Client {
  constructor(env, ip = "203.0.113.1") {
    this.env = env;
    this.ip = ip;
    this.cookie = "";
  }
  async request(method, path, body, { headers = {}, raw = false } = {}) {
    const init = { method, headers: { "CF-Connecting-IP": this.ip, Origin: ORIGIN, ...headers } };
    if (this.cookie) init.headers.Cookie = this.cookie;
    if (body !== undefined) {
      if (raw) init.body = body;
      else {
        init.body = JSON.stringify(body);
        init.headers["Content-Type"] ??= "application/json";
      }
    }
    const response = await worker.fetch(new Request(ORIGIN + path, init), this.env);
    const setCookie = response.headers.get("Set-Cookie");
    if (setCookie) {
      const pair = setCookie.split(";")[0];
      this.cookie = pair.endsWith("=") ? "" : pair;
    }
    const type = response.headers.get("Content-Type") || "";
    const data = type.includes("json") ? await response.json() : await response.text();
    return { status: response.status, data, headers: response.headers };
  }
  get(path) { return this.request("GET", path); }
  post(path, body, opts) { return this.request("POST", path, body, opts); }
  patch(path, body) { return this.request("PATCH", path, body); }
  delete(path) { return this.request("DELETE", path); }
}

let counter = 0;
export async function newMerchant(env, overrides = {}) {
  counter += 1;
  const client = new Client(env, `198.51.100.${counter % 250}`);
  const data = {
    name: `Loja Teste ${counter}`,
    slug: `loja-teste-${counter}`,
    email: `lojista${counter}@exemplo.com.br`,
    password: "senha-forte-123",
    ...overrides,
  };
  const res = await client.post("/api/register", data);
  if (res.status !== 201) throw new Error(`cadastro falhou: ${JSON.stringify(res.data)}`);
  return { client, ...data };
}

export function workerFetch(env, request) {
  return worker.fetch(request, env);
}
