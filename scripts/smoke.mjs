// Teste de fumaça da produção: percorre o caminho principal com uma loja de
// teste temporária e a exclui no final (nenhum dado real é tocado).
//
//   node scripts/smoke.mjs https://def-commerce.detauffer.workers.dev
//
// Sai com código 1 se algo falhar. Não imprime senhas nem cookies.

const BASE = (process.argv[2] || process.env.SMOKE_URL || "").replace(/\/$/, "");
if (!BASE) {
  console.error("Informe a URL: node scripts/smoke.mjs https://...");
  process.exit(2);
}

const stamp = Date.now().toString(36);
const slug = `teste-${stamp}`;
const email = `smoke-${stamp}@exemplo.com.br`;
const password = `Smoke-${crypto.randomUUID()}`;
let cookie = "";
let created = false;
let failures = 0;

async function call(method, path, body, { raw = false, headers = {} } = {}) {
  const init = { method, headers: { Origin: BASE, ...headers }, redirect: "manual" };
  if (cookie) init.headers.Cookie = cookie;
  if (body !== undefined) {
    init.body = raw ? body : JSON.stringify(body);
    if (!raw) init.headers["Content-Type"] = "application/json";
  }
  const res = await fetch(BASE + path, init);
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

async function step(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.log(`FALHOU - ${name}: ${error.message}`);
  }
}

const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

// PNG 8×8 válido (o servidor confere os bytes iniciais).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGNQTX6NFTEMLQkADGRcwcht3uAAAAAASUVORK5CYII=", "base64");

let productId = "";
let orderId = "";
let tracking = "";

await step("saúde do Worker e do banco", async () => {
  const r = await call("GET", "/api/health");
  expect(r.status === 200 && r.data.database === "connected", `status ${r.status}`);
});

await step("páginas públicas (landing, painel, privacidade) e cabeçalhos de segurança", async () => {
  for (const path of ["/", "/painel", "/privacidade", "/termos"]) {
    const r = await call("GET", path);
    expect(r.status === 200, `${path} respondeu ${r.status}`);
  }
  const r = await call("GET", "/");
  expect((r.headers.get("content-security-policy") || "").includes("script-src 'self'"), "CSP ausente");
  expect((r.headers.get("strict-transport-security") || "").includes("max-age"), "HSTS ausente");
});

await step("vitrine inexistente responde 404", async () => {
  const r = await call("GET", `/loja/${slug}-nao-existe`);
  expect(r.status === 404, `respondeu ${r.status}`);
});

await step("cadastro de loja (cria usuário, loja e sessão)", async () => {
  const r = await call("POST", "/api/register", { name: `Loja Teste ${stamp}`, slug, email, password });
  expect(r.status === 201, `respondeu ${r.status}: ${JSON.stringify(r.data)}`);
  created = true;
  expect(cookie.startsWith("__Host-"), "cookie de sessão seguro ausente");
});

await step("sessão: /api/me e logout/login", async () => {
  let r = await call("GET", "/api/me");
  expect(r.status === 200 && r.data.store.slug === slug, `me ${r.status}`);
  r = await call("POST", "/api/logout", {});
  expect(r.status === 200, `logout ${r.status}`);
  cookie = "";
  r = await call("GET", "/api/me");
  expect(r.status === 401, `sem sessão deveria ser 401, veio ${r.status}`);
  r = await call("POST", "/api/login", { email, password });
  expect(r.status === 200, `login ${r.status}`);
});

await step("configurações e produto com custo (banco)", async () => {
  let r = await call("PATCH", "/api/settings", { whatsapp: "5554999990000", pickup_enabled: true });
  expect(r.status === 200, `settings ${r.status}: ${JSON.stringify(r.data)}`);
  r = await call("POST", "/api/products", { name: "Produto de teste", price_cents: 1990, stock: 5, cost_cents: 900, category: "Teste" });
  expect(r.status === 201, `produto ${r.status}: ${JSON.stringify(r.data)}`);
  productId = r.data.id;
});

await step("foto do produto no R2 (envio e leitura)", async () => {
  const r = await call("POST", `/api/products/${productId}/images`, PNG, { raw: true, headers: { "Content-Type": "image/png" } });
  expect(r.status === 201, `upload ${r.status}: ${JSON.stringify(r.data)}`);
  const list = await call("GET", "/api/products");
  const url = list.data.find((p) => p.id === productId)?.images?.[0]?.url;
  expect(url, "imagem não listada");
  const img = await fetch(BASE + url);
  expect(img.status === 200, `imagem respondeu ${img.status}`);
});

await step("vitrine pública da loja de teste", async () => {
  const page = await call("GET", `/loja/${slug}`);
  expect(page.status === 200 && String(page.data).includes(`Loja Teste ${stamp}`), `página ${page.status}`);
  const api = await call("GET", `/api/store/${slug}`);
  expect(api.status === 200 && api.data.products.length === 1, `api ${api.status}`);
  expect(api.data.products[0].cost_cents === undefined, "custo exposto na vitrine");
});

await step("pedido pela vitrine e confirmação com baixa de estoque", async () => {
  const saved = cookie;
  cookie = "";
  const r = await call("POST", `/api/order-request/${slug}`, { customer_name: "Cliente Teste", customer_phone: "54999990000", fulfillment: "pickup", items: [{ id: productId, quantity: 2 }] });
  cookie = saved;
  expect(r.status === 201 && r.data.total_cents === 3980, `pedido ${r.status}: ${JSON.stringify(r.data)}`);
  orderId = r.data.id;
  tracking = r.data.tracking_url || "";
  const c = await call("PATCH", `/api/orders/${orderId}`, { status: "confirmed" });
  expect(c.status === 200, `confirmar ${c.status}`);
  const p = (await call("GET", "/api/products")).data.find((x) => x.id === productId);
  expect(p.stock === 3, `estoque ${p.stock}, esperado 3`);
});

if (tracking) {
  await step("acompanhamento do pedido sem dados pessoais", async () => {
    const token = tracking.split("/").pop();
    const r = await call("GET", `/api/order-status/${token}`);
    expect(r.status === 200 && r.data.status === "confirmed", `status ${r.status}`);
    expect(!JSON.stringify(r.data).includes("54999990000"), "telefone exposto");
  });
}

await step("resumo da loja (lucro com custo histórico)", async () => {
  const r = await call("GET", "/api/dashboard?period=today");
  if (r.status === 404) return; // versão sem o resumo
  expect(r.status === 200 && r.data.current.cogs === 1800, `resumo ${r.status}: cogs ${r.data?.current?.cogs}`);
});

// Limpeza: exclui a loja de teste (e a foto no R2) mesmo se algo falhou.
if (created) {
  await step("exclusão da loja de teste (limpeza)", async () => {
    if (!cookie) await call("POST", "/api/login", { email, password });
    const r = await call("POST", "/api/account/delete", { password, confirm_slug: slug });
    expect(r.status === 200, `exclusão ${r.status}: ${JSON.stringify(r.data)}`);
    const gone = await call("GET", `/api/store/${slug}`);
    expect(gone.status === 404, "loja de teste ainda existe");
  });
}

console.log(failures ? `\n${failures} verificação(ões) falharam.` : "\nProdução verificada: tudo certo.");
process.exit(failures ? 1 : 0);
