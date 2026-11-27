import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, ORIGIN, createEnv, newMerchant, workerFetch } from "./helpers/env.js";

test("ordem das categorias é salva por loja e enviada à vitrine", async () => {
  const env = createEnv();
  const m = await newMerchant(env);
  const other = await newMerchant(env);
  assert.deepEqual((await m.client.get("/api/categories/order")).data.order, []);
  const res = await m.client.request("PUT", "/api/categories/order", { order: ["Vestidos", " Blusas ", "Vestidos", ""] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.order, ["Vestidos", "Blusas"]);
  assert.deepEqual((await new Client(env).get(`/api/store/${m.slug}`)).data.category_order, ["Vestidos", "Blusas"]);
  assert.deepEqual((await new Client(env).get(`/api/store/${other.slug}`)).data.category_order, []);
  assert.equal((await m.client.request("PUT", "/api/categories/order", { order: "Vestidos" })).status, 400);
});

test("página de catálogo para imprimir existe e não é indexada", async () => {
  const env = createEnv();
  const m = await newMerchant(env);
  const res = await workerFetch(env, new Request(`${ORIGIN}/loja/${m.slug}/catalogo`));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Robots-Tag"), "noindex");
  assert.match(await res.text(), /js\/catalogo\.js/);
});
