// Teste de ponta a ponta em navegador real (Chromium via Playwright):
// cadastro → produto com foto → configuração → vitrine → carrinho →
// pedido pelo WhatsApp → confirmação no painel com baixa de estoque.
// Também verifica erros de console (inclusive violações de CSP) e rolagem
// horizontal em telas de celular.

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { startServer } from "./server.js";
import { hashPassword } from "../../src/lib/crypto.js";
import { currentStep, totpAt } from "../../src/lib/totp.js";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const SHOTS = process.env.E2E_SCREENSHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
// PNG 8x8 válido.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGNQTX6NFTEMLQkADGRcwcht3uAAAAAASUVORK5CYII=", "base64");

const { server, env, url } = await startServer();
const browser = await chromium.launch();
const errors = [];
let consoleMuted = false; // durante o teste offline, falhas de rede são esperadas
let step = "início";
const results = [];

function watch(page, label) {
  page.on("console", (msg) => {
    // O 401 de /api/me sem sessão é esperado (é assim que o painel sabe que deve mostrar o login).
    if (msg.type() === "error" && !consoleMuted && !/status of 401/.test(msg.text())) errors.push(`${label}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`${label}: ${err.message}`));
  page.on("dialog", (d) => d.accept());
}

async function check(name, fn) {
  step = name;
  await fn();
  results.push(name);
  console.log(`ok - ${name}`);
}

async function noHorizontalScroll(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `${label}: rolagem horizontal de ${overflow}px`);
}

async function noDialogOverflow(dialog, label) {
  const overflow = await dialog.evaluate((d) => Math.max(...[d, ...d.querySelectorAll("*")].map((e) => e.scrollWidth - e.clientWidth).filter((n) => !Number.isNaN(n))));
  assert.ok(overflow <= 1, `${label}: conteúdo do diálogo transborda ${overflow}px`);
}

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

try {
  const mobile = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  const panel = await mobile.newPage();
  watch(panel, "painel");

  await check("landing carrega sem erros e leva ao cadastro", async () => {
    await panel.goto(url + "/");
    await panel.getByRole("heading", { level: 1, name: /Sua loja no celular do cliente/ }).waitFor();
    // Menu do celular abre, leva à seção e fecha.
    await panel.getByRole("button", { name: "Abrir menu" }).click();
    await panel.locator("#site-nav").getByRole("link", { name: "Dúvidas" }).click();
    assert.equal(await panel.getByRole("button", { name: "Abrir menu" }).getAttribute("aria-expanded"), "false");
    await panel.locator("#duvidas summary", { hasText: "Como recebo o pagamento?" }).click();
    await noHorizontalScroll(panel, "landing");
    await shot(panel, "01-landing-mobile");
    await panel.getByRole("link", { name: /Criar minha loja grátis/ }).first().click();
    await panel.waitForURL(/\/painel#cadastro$/);
  });

  await check("cadastro do lojista abre o painel com onboarding", async () => {
    await panel.getByRole("tab", { name: "Criar minha loja" }).waitFor();
    assert.equal(await panel.getByRole("tab", { name: "Criar minha loja" }).getAttribute("aria-selected"), "true");
    const form = panel.locator("#register");
    await form.getByLabel("Nome da loja").fill("Moda da Ana");
    assert.equal(await form.locator("input[name=slug]").inputValue(), "moda-da-ana");
    await form.getByLabel("E-mail").fill("ana@exemplo.com.br");
    await form.getByLabel("Senha").fill("senha-forte-123");
    await form.getByRole("checkbox").check();
    await form.getByRole("button", { name: "Criar loja grátis" }).click();
    await panel.locator("#onboarding").waitFor();
    assert.equal(await panel.locator("#store-name").textContent(), "Moda da Ana");
    await noHorizontalScroll(panel, "painel início");
    await shot(panel, "02-painel-inicio-mobile");
  });

  await check("cadastro de produto com foto, promoção e destaque", async () => {
    await panel.locator('.nav a[data-view="produtos"]').click();
    await panel.getByRole("button", { name: "Cadastrar primeiro produto" }).click();
    const dialog = panel.locator("#product-dialog");
    await dialog.getByLabel("Nome do produto").fill("Vestido Floral");
    await dialog.getByLabel("Descrição").fill("Tecido leve, ideal para o verão.");
    await dialog.getByLabel("Preço (R$)", { exact: true }).fill("149,90");
    await dialog.getByLabel("Preço promocional (R$)").fill("119,90");
    await dialog.getByLabel("Estoque").fill("3");
    await dialog.getByLabel("SKU / código").fill("VES-01");
    await dialog.getByLabel("Categoria").fill("Vestidos");
    await dialog.getByLabel("Destacar na vitrine").check();
    await panel.locator("#image-input").setInputFiles({ name: "foto.png", mimeType: "image/png", buffer: PNG });
    await dialog.locator("figure").first().waitFor();
    await shot(panel, "03-produto-formulario-mobile");
    await dialog.getByRole("button", { name: "Salvar produto" }).click();
    await dialog.waitFor({ state: "hidden" });
    const item = panel.locator(".product-item").first();
    await item.waitFor();
    assert.match(await item.textContent(), /Vestido Floral/);
    assert.match(await item.textContent(), /R\$\s?119,90/);
    assert.match(await item.locator(".thumb").getAttribute("style"), /\/img\/stores\//);
    await noHorizontalScroll(panel, "produtos");
    await shot(panel, "04-produtos-mobile");
  });

  await check("configuração da loja com WhatsApp e cor", async () => {
    await panel.locator('.nav a[data-view="loja"]').click();
    const form = panel.locator("#settings");
    await panel.locator("#share-url").evaluate((el) => new Promise((ok) => { const t = () => (el.value ? ok() : setTimeout(t, 50)); t(); }));
    await form.getByLabel("WhatsApp de atendimento").fill("55 54 99999-0000");
    await form.getByLabel("Descrição curta").fill("Moda feminina com entrega na cidade.");
    await form.getByRole("button", { name: "Salvar alterações" }).click();
    await panel.locator("#toast", { hasText: "Configurações salvas" }).waitFor();
    assert.equal(await form.getByLabel("WhatsApp de atendimento").inputValue(), "5554999990000");
    await noHorizontalScroll(panel, "loja");
  });

  const shop = await mobile.newPage();
  watch(shop, "vitrine");
  let whatsappUrl = "";
  await shop.route("https://wa.me/**", (route) => { whatsappUrl = route.request().url(); route.fulfill({ status: 200, body: "ok" }); });

  await check("vitrine pública mostra produto, destaque e carrinho", async () => {
    await shop.goto(url + "/loja/moda-da-ana");
    await shop.locator("#store-name", { hasText: "Moda da Ana" }).waitFor();
    assert.equal(await shop.locator("#featured .product").count(), 1);
    const card = shop.locator("#products .product").first();
    assert.match(await card.textContent(), /-20%/);
    await card.getByRole("button", { name: "Adicionar" }).click();
    await card.getByRole("button", { name: /Adicionar uma unidade/ }).click();
    assert.equal(await shop.locator("#cart-count").textContent(), "2");
    assert.match(await shop.locator("#cart-total").textContent(), /239,80/);
    await noHorizontalScroll(shop, "vitrine");
    await shot(shop, "05-vitrine-mobile");
  });

  await check("checkout registra pedido e abre WhatsApp com o resumo", async () => {
    await shop.locator("#cart-bar").click();
    const dialog = shop.locator("#cart-dialog");
    await dialog.getByLabel("Nome").fill("Maria Cliente");
    await dialog.getByLabel("Telefone / WhatsApp").fill("(54) 98888-7777");
    await dialog.getByLabel("Observações").fill("Entregar à tarde");
    await shot(shop, "06-checkout-mobile");
    await dialog.getByRole("button", { name: "Enviar pedido pelo WhatsApp" }).click();
    await shop.waitForURL(/wa\.me/);
    assert.match(whatsappUrl, /^https:\/\/wa\.me\/5554999990000\?text=/);
    const text = decodeURIComponent(whatsappUrl.split("text=")[1]);
    assert.match(text, /2x Vestido Floral/);
    assert.match(text, /Total: R\$\s?239,80/);
    assert.match(text, /Entregar à tarde/);
  });

  await check("lojista confirma o pedido e o estoque é baixado", async () => {
    await panel.locator('.nav a[data-view="pedidos"]').click();
    const order = panel.locator(".order").first();
    await order.waitFor();
    assert.match(await order.textContent(), /Maria Cliente/);
    assert.match(await order.textContent(), /Pendente/);
    await noHorizontalScroll(panel, "pedidos");
    await shot(panel, "07-pedidos-mobile");
    await order.getByRole("button", { name: "Confirmar e baixar estoque" }).click();
    await panel.locator(".order", { hasText: "Confirmado" }).waitFor();
    await panel.locator('.nav a[data-view="produtos"]').click();
    await panel.locator(".product-item", { hasText: "1 em estoque" }).waitFor();
  });

  await check("clientes e indicadores são atualizados", async () => {
    await panel.locator('.nav a[data-view="clientes"]').click();
    await panel.locator("#customer-list .row", { hasText: "Maria Cliente" }).waitFor();
    await panel.locator('.nav a[data-view="inicio"]').click();
    await panel.locator("#kpis .kpi").first().waitFor();
    await panel.locator("#kpis .kpi", { hasText: "Faturamento" }).waitFor();
    assert.match(await panel.locator("#kpis").textContent(), /Vendas1/);
    // Recomendação acionável: produto sem custo leva à lista filtrada.
    const tip = panel.locator("#dash-tips .tip", { hasText: "preço de custo" });
    await tip.click();
    await panel.locator("#product-list .filter-banner", { hasText: "Sem preço de custo" }).waitFor();
    await panel.locator("#product-list .product-item").first().click();
    const pf = panel.locator("#product-form");
    await pf.locator("#product-advanced > summary").click();
    await pf.getByLabel("Preço de custo (R$)").fill("50,00");
    await pf.locator("#margin-info", { hasText: "margem" }).waitFor();
    await pf.getByLabel("Fornecedor").fill("Ateliê Central");
    await pf.getByRole("button", { name: "Salvar produto" }).click();
    await panel.locator("#product-dialog").waitFor({ state: "hidden" });
    await panel.locator('.nav a[data-view="inicio"]').click();
    await panel.locator("#dash-periods").getByRole("button", { name: "Hoje" }).click();
    await panel.locator("#kpis .kpi", { hasText: "Investido em estoque" }).filter({ hasText: "R$" }).waitFor();
    await shot(panel, "02b-resumo-mobile");
  });

  await check("todas as telas sem rolagem horizontal a 320 px", async () => {
    // Margem para fontes mais largas que as desta máquina (ex.: no CI).
    const narrow = await browser.newContext({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
    await narrow.addCookies(await mobile.cookies());
    const page = await narrow.newPage();
    watch(page, "320px");
    for (const view of ["inicio", "produtos", "pedidos", "divulgacao", "clientes", "loja"]) {
      await page.goto(`${url}/painel#${view}`);
      await page.locator(`#view-${view}`).waitFor();
      await page.waitForLoadState("networkidle");
      await noHorizontalScroll(page, `painel ${view} 320px`);
    }
    await page.goto(url + "/loja/moda-da-ana");
    await page.locator("#products .product").first().waitFor();
    await noHorizontalScroll(page, "vitrine 320px");
    await narrow.close();
  });

  await check("painel no desktop sem rolagem horizontal", async () => {
    const desktop = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    await desktop.addCookies(await mobile.cookies());
    const page = await desktop.newPage();
    watch(page, "desktop");
    await page.goto(url + "/painel#pedidos");
    await page.locator(".order").first().waitFor();
    await noHorizontalScroll(page, "desktop pedidos");
    await shot(page, "08-pedidos-desktop");
    await page.goto(url + "/loja/moda-da-ana");
    await page.locator("#products .product").first().waitFor();
    await shot(page, "09-vitrine-desktop");
    await desktop.close();
  });

  await check("produto com variações: gerador, escolha na vitrine e baixa na variação", async () => {
    await panel.goto(url + "/painel#produtos");
    await panel.getByRole("button", { name: "Novo produto" }).click();
    const dialog = panel.locator("#product-dialog");
    await dialog.getByLabel("Nome do produto").fill("Camiseta Básica");
    await dialog.getByLabel("Preço (R$)", { exact: true }).fill("59,90");
    await dialog.getByLabel("Este produto tem opções").check();
    await dialog.getByLabel("Opção 1").fill("P, M");
    await dialog.getByLabel("Opção 2 (opcional)").fill("Azul");
    await dialog.getByRole("button", { name: "Gerar combinações" }).click();
    const rows = dialog.locator(".variant-row");
    assert.equal(await rows.count(), 2);
    await rows.nth(0).locator("[data-k=stock]").fill("2");
    await rows.nth(1).locator("[data-k=stock]").fill("1");
    await rows.nth(1).locator("[data-k=price]").fill("64,90");
    assert.equal(await dialog.getByLabel("Estoque", { exact: true }).inputValue(), "3");
    await noDialogOverflow(dialog, "formulário de produto");
    await noHorizontalScroll(panel, "editor de variações");
    await shot(panel, "10-variacoes-mobile");
    await dialog.getByRole("button", { name: "Salvar produto" }).click();
    await dialog.waitFor({ state: "hidden" });
    const item = panel.locator(".product-item", { hasText: "Camiseta Básica" });
    await item.waitFor();
    assert.match(await item.textContent(), /2 variações/);
    assert.match(await item.textContent(), /3 em estoque/);

    whatsappUrl = "";
    await shop.goto(url + "/loja/moda-da-ana");
    const card = shop.locator("#products .product", { hasText: "Camiseta Básica" });
    assert.match(await card.textContent(), /a partir de/);
    await card.getByRole("button", { name: "Escolher opção" }).click();
    const pd = shop.locator("#product-dialog");
    assert.equal(await pd.getByRole("button", { name: "Adicionar ao pedido" }).isDisabled(), true);
    await pd.getByRole("radio", { name: "M / Azul" }).click();
    assert.match(await shop.locator("#pd-price").textContent(), /64,90/);
    await noDialogOverflow(pd, "detalhe do produto");
    await shot(shop, "11-vitrine-variacao-mobile");
    await pd.getByRole("button", { name: "Adicionar ao pedido" }).click();
    assert.equal(await shop.locator("#cart-count").textContent(), "1");
    await shop.locator("#cart-bar").click();
    const cart = shop.locator("#cart-dialog");
    await cart.getByLabel("Nome").fill("Carlos");
    await cart.getByLabel("Telefone / WhatsApp").fill("(54) 97777-6666");
    await cart.getByRole("button", { name: "Enviar pedido pelo WhatsApp" }).click();
    await shop.waitForURL(/wa\.me/);
    assert.match(decodeURIComponent(whatsappUrl), /1x Camiseta Básica \(M \/ Azul\)/);

    await panel.goto(url + "/painel#pedidos");
    const order = panel.locator(".order", { hasText: "Carlos" });
    await order.waitFor();
    await order.getByRole("button", { name: "Confirmar e baixar estoque" }).click();
    await panel.locator(".order", { hasText: "Carlos" }).filter({ hasText: "Confirmado" }).waitFor();
    await panel.goto(url + "/painel#produtos");
    await panel.locator(".product-item", { hasText: "Camiseta Básica" }).filter({ hasText: "2 em estoque" }).waitFor();
  });

  await check("funcionário com acesso só a pedidos troca a senha no primeiro acesso", async () => {
    await panel.goto(url + "/painel#loja");
    await panel.locator("#team-card summary").click();
    const form = panel.locator("#team-form");
    await form.getByLabel("Nome").fill("Bruno Vendas");
    await form.getByLabel("E-mail").fill("bruno.vendas.atendimento.loja@exemplo.com.br");
    await form.getByLabel("Senha provisória").fill("provisoria-123");
    await form.getByLabel("Produtos e estoque").uncheck();
    await form.getByRole("button", { name: "Adicionar à equipe" }).click();
    await panel.locator(".team-member", { hasText: "Bruno Vendas" }).waitFor();
    assert.match(await panel.locator(".team-member", { hasText: "Bruno Vendas" }).textContent(), /Aguardando 1º acesso/);
    await noHorizontalScroll(panel, "equipe");

    const staffCtx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    const staff = await staffCtx.newPage();
    watch(staff, "funcionário");
    await staff.goto(url + "/painel");
    const login = staff.locator("#login");
    await login.getByLabel("E-mail").fill("bruno.vendas.atendimento.loja@exemplo.com.br");
    await login.getByLabel("Senha").fill("provisoria-123");
    await login.getByRole("button", { name: "Entrar no painel" }).click();
    const pw = staff.locator("#password-dialog");
    await pw.getByRole("heading", { name: "Crie sua senha" }).waitFor();
    await pw.getByLabel("Senha atual").fill("provisoria-123");
    await pw.locator("input[name=new_password]").fill("senha-do-bruno-1");
    await pw.getByLabel("Repita a nova senha").fill("senha-do-bruno-1");
    await pw.getByRole("button", { name: "Salvar nova senha" }).click();
    await pw.waitFor({ state: "hidden" });
    assert.equal(await staff.locator('.nav a[data-view="produtos"]').isVisible(), false);
    assert.equal(await staff.locator('.nav a[data-view="loja"]').isVisible(), false);
    await staff.locator('.nav a[data-view="pedidos"]').click();
    await staff.locator(".order", { hasText: "Carlos" }).waitFor();
    await staff.goto(url + "/painel#produtos");
    await staff.locator("#view-inicio").waitFor();
    assert.equal(await staff.locator("#view-produtos").isVisible(), false);
    await noHorizontalScroll(staff, "painel do funcionário");
    await staffCtx.close();
  });

  await check("super administrador suspende e reativa uma loja", async () => {
    const adminId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO users(id,email,password_hash) VALUES(?,?,?)").bind(adminId, "admin@defcommerce.test", await hashPassword("admin-senha-forte")).run();
    await env.DB.prepare("INSERT INTO platform_admins(user_id) VALUES(?)").bind(adminId).run();
    const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const admin = await adminCtx.newPage();
    watch(admin, "admin");
    await admin.goto(url + "/admin");
    const adminLogin = admin.locator("#login");
    await adminLogin.getByLabel("E-mail").fill("admin@defcommerce.test");
    await adminLogin.getByLabel("Senha", { exact: true }).fill("admin-senha-forte");
    await adminLogin.getByRole("button", { name: "Entrar" }).click();
    const row = admin.locator("#stores tr", { hasText: "Moda da Ana" });
    await row.waitFor();
    await admin.locator("#errors-summary", { hasText: "erro(s) nas últimas 24 horas" }).waitFor();
    await shot(admin, "12-admin-desktop");
    await row.getByRole("button", { name: "Suspender" }).click();
    await admin.locator("#suspend-dialog").getByLabel("Motivo").fill("Teste de suspensão");
    await admin.locator("#suspend-dialog").getByRole("button", { name: "Suspender" }).click();
    await admin.locator("#stores tr", { hasText: "Moda da Ana" }).filter({ hasText: "Suspensa" }).waitFor();
    const visitor = await adminCtx.newPage();
    await visitor.goto(url + "/loja/moda-da-ana");
    await visitor.locator("#store-name", { hasText: "Loja não encontrada" }).waitFor();
    await admin.locator("#stores tr", { hasText: "Moda da Ana" }).getByRole("button", { name: "Reativar" }).click();
    await admin.locator("#stores tr", { hasText: "Moda da Ana" }).filter({ hasText: "Ativa" }).waitFor();
    await admin.locator("#audit summary").click();
    await admin.locator("#audit-list .row", { hasText: "Loja suspensa" }).waitFor();
    // Planos: o administrador cria um plano pago; o lojista o vê, sem cobrança ativa.
    await admin.locator("#plan-form-box summary").click();
    const planForm = admin.locator("#plan-form");
    await planForm.getByLabel("Código").fill("profissional");
    await planForm.getByLabel("Nome").fill("Profissional");
    await planForm.getByLabel("Preço por mês (R$)").fill("49,90");
    await planForm.getByLabel("Máx. de produtos").fill("500");
    await planForm.getByRole("button", { name: "Salvar plano" }).click();
    await admin.locator("#plans-body tr", { hasText: "Profissional" }).filter({ hasText: "R$ 49,90" }).waitFor();
    await admin.locator("#billing-flag", { hasText: "Cobrança desativada" }).waitFor();
    await panel.goto(url + "/painel#loja");
    await panel.reload();
    await panel.locator("#plan-box .plan-option", { hasText: "Profissional" }).waitFor();
    await panel.locator("#plan-box", { hasText: "Os pagamentos ainda não foram ativados" }).waitFor();
    assert.doesNotMatch(await panel.locator("#plan-box").textContent(), /null|undefined/);
    // Lojista não entra na administração.
    const merchantAdmin = await mobile.newPage();
    await merchantAdmin.goto(url + "/admin");
    await merchantAdmin.locator("#login-view").waitFor();
    await merchantAdmin.close();
    await adminCtx.close();
  });

  await check("página própria do produto: link compartilhado abre o produto com título e prévia", async () => {
    const id = (await panel.request.get(url + "/api/products").then((r) => r.json())).find((p) => p.name === "Vestido Floral").id;
    const res = await panel.request.get(`${url}/loja/moda-da-ana/p/${id}`);
    assert.equal(res.status(), 200);
    assert.match(await res.text(), /<meta property="og:type" content="product">/);
    const page = await mobile.newPage();
    watch(page, "produto");
    await page.goto(`${url}/loja/moda-da-ana/p/${id}`);
    await page.locator("#product-dialog #pd-name", { hasText: "Vestido Floral" }).waitFor();
    assert.match(await page.title(), /Vestido Floral/);
    await page.locator("#product-dialog [data-close]").click();
    await page.waitForURL(/\/loja\/moda-da-ana$/);
    // Abrir um produto pela vitrine muda o endereço para o do produto.
    await page.locator("#products .product", { hasText: "Vestido Floral" }).locator(".product-media").click();
    await page.waitForURL(new RegExp(`/loja/moda-da-ana/p/${id}$`));
    await page.close();
  });

  await check("painel avisa de pedido novo sem recarregar", async () => {
    // Espera a primeira consulta: pedidos anteriores a ela já aparecem na lista e não geram aviso.
    const firstPoll = panel.waitForResponse((r) => r.url().includes("/api/notifications"));
    await panel.goto(url + "/painel#pedidos");
    await firstPoll;
    await panel.locator(".order").first().waitFor();
    const id = (await panel.request.get(url + "/api/products").then((r) => r.json())).find((p) => p.name === "Vestido Floral").id;
    const buyer = await browser.newContext();
    const res = await buyer.request.post(`${url}/api/order-request/moda-da-ana`, {
      headers: { Origin: url, "Content-Type": "application/json" },
      data: { customer_name: "Nina Alerta", customer_phone: "54966665555", items: [{ id, quantity: 1 }] },
    });
    assert.equal(res.status(), 201);
    await buyer.close();
    // O painel consulta a cada 30 s e também ao voltar para a aba.
    await panel.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await panel.locator("#toast", { hasText: "Novo pedido" }).waitFor();
    await panel.locator(".order", { hasText: "Nina Alerta" }).waitFor();
    assert.match(await panel.title(), /^\(\d+\) /);
    assert.equal(await panel.locator("#pending-badge").isVisible(), true);
  });

  await check("cupom criado no painel dá desconto na vitrine e aparece no pedido", async () => {
    await panel.goto(url + "/painel#loja");
    await panel.locator("#coupons-card summary").click();
    const form = panel.locator("#coupon-form");
    await form.getByLabel("Código").fill("promo10");
    await form.getByLabel("Desconto", { exact: true }).fill("10");
    await form.getByRole("button", { name: "Criar cupom" }).click();
    await panel.locator("#coupon-list .coupon", { hasText: "PROMO10" }).waitFor();
    await noHorizontalScroll(panel, "cupons");

    whatsappUrl = "";
    await shop.goto(url + "/loja/moda-da-ana");
    const card = shop.locator("#products .product", { hasText: "Camiseta Básica" });
    await card.getByRole("button", { name: "Escolher opção" }).click();
    await shop.locator("#product-dialog").getByRole("radio", { name: "P / Azul" }).click();
    await shop.locator("#product-dialog").getByRole("button", { name: "Adicionar ao pedido" }).click();
    await shop.locator("#cart-bar").click();
    const cart = shop.locator("#cart-dialog");
    await cart.locator("#coupon-input").fill("PROMOERRADO");
    await cart.getByRole("button", { name: "Aplicar" }).click();
    await cart.locator("#coupon-msg.error").waitFor();
    await cart.locator("#coupon-input").fill("promo10");
    await cart.locator("#coupon-input").press("Enter");
    await cart.locator("#coupon-msg.ok").waitFor();
    assert.match(await cart.locator("#cart-disc-value").textContent(), /5,99/);
    assert.match(await cart.locator("#cart-sum").textContent(), /53,91/);
    await noDialogOverflow(cart, "carrinho com cupom");
    await shot(shop, "14-cupom-mobile");
    await cart.getByLabel("Nome").fill("Rita Cupom");
    await cart.getByLabel("Telefone / WhatsApp").fill("(54) 95555-4444");
    await cart.getByRole("button", { name: "Enviar pedido pelo WhatsApp" }).click();
    await shop.waitForURL(/wa\.me/);
    const text = decodeURIComponent(whatsappUrl);
    assert.match(text, /Cupom PROMO10: − R\$\s?5,99/);
    assert.match(text, /Total: R\$\s?53,91/);
    await panel.goto(url + "/painel#pedidos");
    const order = panel.locator(".order", { hasText: "Rita Cupom" });
    await order.waitFor();
    assert.match(await order.textContent(), /Cupom PROMO10/);
  });

  await check("painel instalável: manifesto, service worker e abertura sem internet", async () => {
    await panel.goto(url + "/painel#inicio");
    assert.equal(await panel.locator('link[rel="manifest"]').getAttribute("href"), "/manifest.webmanifest");
    const active = await panel.evaluate(() => navigator.serviceWorker.ready.then((r) => !!r.active));
    assert.equal(active, true);
    await panel.reload(); // garante que o painel já passou pelo service worker
    await panel.locator("#app").waitFor();
    consoleMuted = true;
    await mobile.setOffline(true);
    try {
      await panel.reload();
      await panel.locator("#auth-error", { hasText: "Sem conexão" }).waitFor();
    } finally {
      await mobile.setOffline(false);
      consoleMuted = false;
    }
    await panel.reload();
    await panel.locator("#app").waitFor();
  });

  await check("entrega com taxa no checkout, endereço no pedido e impressão", async () => {
    await panel.goto(url + "/painel#loja");
    const form = panel.locator("#settings");
    await form.getByLabel("Cliente pode retirar na loja").check();
    await form.getByLabel("Faço entregas").check();
    await form.getByLabel("Taxa de entrega (R$)").fill("8,00");
    await form.getByLabel("Grátis a partir de (R$)").fill("200,00");
    await form.getByRole("button", { name: "Salvar alterações" }).click();
    await panel.locator("#toast", { hasText: "Configurações salvas" }).waitFor();

    whatsappUrl = "";
    await shop.goto(url + "/loja/moda-da-ana");
    await shop.locator("#products .product", { hasText: "Camiseta Básica" }).getByRole("button", { name: "Escolher opção" }).click();
    await shop.locator("#product-dialog").getByRole("radio", { name: "P / Azul" }).click();
    await shop.locator("#product-dialog").getByRole("button", { name: "Adicionar ao pedido" }).click();
    await shop.locator("#cart-bar").click();
    const cart = shop.locator("#cart-dialog");
    await cart.locator("#ship-box").waitFor();
    assert.match(await cart.locator("#fee-note").textContent(), /Taxa de R\$\s?8,00 · grátis acima de R\$\s?200,00/);
    await cart.getByText("Receber em casa").click();
    assert.match(await cart.locator("#cart-fee").textContent(), /8,00/);
    assert.match(await cart.locator("#cart-sum").textContent(), /67,90/);
    await cart.getByLabel("Nome").fill("Pedro Entrega");
    await cart.getByLabel("Telefone / WhatsApp").fill("(54) 94444-3333");
    await cart.getByRole("button", { name: "Enviar pedido pelo WhatsApp" }).click();
    await cart.locator("#checkout-error", { hasText: "endereço" }).waitFor();
    await cart.getByLabel("Endereço de entrega").fill("Rua das Acácias, 120 - Centro");
    await noDialogOverflow(cart, "carrinho com entrega");
    await shot(shop, "15-entrega-mobile");
    await cart.getByRole("button", { name: "Enviar pedido pelo WhatsApp" }).click();
    await shop.waitForURL(/wa\.me/);
    const text = decodeURIComponent(whatsappUrl);
    assert.match(text, /Entrega em: Rua das Acácias, 120 - Centro/);
    assert.match(text, /Total: R\$\s?67,90/);

    await panel.goto(url + "/painel#pedidos");
    const order = panel.locator(".order", { hasText: "Pedro Entrega" });
    await order.waitFor();
    assert.match(await order.textContent(), /Entrega \(taxa R\$\s?8,00\)Rua das Acácias/);
    await order.getByRole("button", { name: /Imprimir pedido/ }).click();
    await panel.waitForFunction(() => !document.body.classList.contains("printing"), null, { timeout: 5000 });
  });

  await check("gráfico de vendas por dia com dica, períodos e tabela", async () => {
    await panel.goto(url + "/painel#inicio");
    const perf = panel.locator("#perf-card");
    await perf.locator(".chart svg .bar").first().waitFor();
    assert.match(await perf.locator("#perf-summary").textContent(), /Vendas no período/);
    const bar = perf.locator(".chart svg .bar").last();
    const box = await bar.boundingBox();
    const chartBox = await perf.locator(".chart svg").boundingBox();
    // Toque na barra (celular) mostra a dica do dia.
    await perf.locator(".chart svg").tap({ position: { x: box.x - chartBox.x + box.width / 2, y: box.y - chartBox.y + 2 } });
    const tip = perf.locator(".chart-tip");
    await tip.waitFor();
    assert.match(await tip.textContent(), /R\$/);
    // Teclado: setas percorrem os dias.
    await perf.locator(".chart svg").focus();
    await panel.keyboard.press("ArrowLeft");
    assert.match(await tip.textContent(), /pedido\(s\)/);
    await perf.getByRole("button", { name: "7 dias" }).click();
    await perf.locator('#perf-periods .chip[data-days="7"][aria-pressed="true"]').waitFor();
    await perf.locator("summary", { hasText: "Ver como tabela" }).click();
    assert.equal(await perf.locator("#perf-table tbody tr").count(), 7);
    assert.ok((await perf.locator("#perf-top .row").count()) >= 1);
    await noHorizontalScroll(panel, "desempenho");
    await shot(panel, "13-desempenho-mobile");
  });

  await check("vitrine com título, descrição e prévia de compartilhamento da loja", async () => {
    const res = await panel.request.get(url + "/loja/moda-da-ana");
    const html = await res.text();
    assert.match(html, /<title>Moda da Ana \| Catálogo<\/title>/);
    assert.match(html, /<meta property="og:description" content="Moda feminina com entrega na cidade.">/);
    assert.match(html, /application\/ld\+json/);
    assert.equal((await panel.request.get(url + "/loja/nao-existe")).status(), 404);
    assert.match(await (await panel.request.get(url + "/sitemap.xml")).text(), /\/loja\/moda-da-ana/);
  });

  await check("LGPD: exportar dados e excluir dados de um cliente", async () => {
    await panel.goto(url + "/painel#loja");
    const download = panel.waitForEvent("download");
    await panel.getByRole("button", { name: "Exportar dados" }).click();
    const file = await download;
    assert.match(file.suggestedFilename(), /^def-commerce-moda-da-ana-.*\.json$/);
    const data = JSON.parse(await (await import("node:fs/promises")).readFile(await file.path(), "utf8"));
    assert.equal(data.store.slug, "moda-da-ana");
    assert.ok(data.orders.length >= 2);
    await panel.goto(url + "/painel#clientes");
    await panel.getByRole("button", { name: "Excluir dados de Carlos" }).click();
    await panel.locator("#toast", { hasText: "Dados do cliente excluídos" }).waitFor();
    assert.equal(await panel.locator("#customer-list .row", { hasText: "Carlos" }).count(), 0);
    await panel.goto(url + "/painel#pedidos");
    await panel.locator(".order", { hasText: "Cliente removido" }).waitFor();
  });

  await check("verificação em duas etapas: ativar no painel e entrar com o código", async () => {
    await panel.goto(url + "/painel#inicio");
    await panel.getByRole("button", { name: "Alterar senha" }).click();
    const dialog = panel.locator("#password-dialog");
    const box = dialog.locator("#tfa-box");
    await box.getByLabel("Sua senha").fill("senha-forte-123");
    await box.getByRole("button", { name: "Ativar verificação em duas etapas" }).click();
    const secret = (await box.locator(".tfa-secret").textContent()).replace(/\s/g, "");
    await box.getByLabel("Código do aplicativo").fill(await totpAt(secret, currentStep()));
    await box.getByRole("button", { name: "Confirmar e ativar" }).click();
    await box.locator(".tfa-codes li").first().waitFor();
    assert.equal(await box.locator(".tfa-codes li").count(), 8);
    await noDialogOverflow(dialog, "2FA");
    await shot(panel, "16-2fa-mobile");
    await box.getByRole("button", { name: "Concluído" }).click();
    await box.locator(".tfa-on").waitFor();
    await panel.locator("#password-close").click();

    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    watch(page, "2fa");
    await page.goto(url + "/painel");
    await page.locator("#login").getByLabel("E-mail").fill("ana@exemplo.com.br");
    await page.locator("#login").getByLabel("Senha").fill("senha-forte-123");
    await page.locator("#login").getByRole("button", { name: "Entrar no painel" }).click();
    const step2 = page.locator("#login-2fa");
    await step2.waitFor();
    await step2.getByLabel("Código").fill(await totpAt(secret, currentStep() + 1));
    await step2.getByRole("button", { name: "Confirmar" }).click();
    await page.locator("#app").waitFor();
    assert.equal(await page.locator("#store-name").textContent(), "Moda da Ana");
    await ctx.close();
  });

  await check("ordem das categorias e catálogo para imprimir/PDF", async () => {
    await panel.goto(url + "/painel#produtos");
    await panel.locator(".product-item").first().waitFor();
    await panel.locator("#category-card summary").click();
    await panel.locator("#category-order .cat-order li", { hasText: "Vestidos" }).waitFor();
    await panel.locator("#category-order").getByRole("button", { name: "Salvar ordem" }).click();
    await panel.locator("#toast", { hasText: "Ordem das categorias salva" }).waitFor();
    await panel.goto(url + "/painel#loja");
    assert.equal(await panel.locator("#catalog-pdf").getAttribute("href"), "/loja/moda-da-ana/catalogo");
    const page = await mobile.newPage();
    watch(page, "catálogo");
    await page.goto(url + "/loja/moda-da-ana/catalogo");
    await page.locator("#sections .cat-item", { hasText: "Vestido Floral" }).waitFor();
    assert.match(await page.locator("#sections").textContent(), /Opções: P \/ Azul, M \/ Azul/);
    assert.match(await page.locator("#foot").textContent(), /\(54\) 99999-0000/);
    await noHorizontalScroll(page, "catálogo");
    await shot(page, "17-catalogo-mobile");
    // Margem para fontes mais largas (CI): também a 320 px.
    await page.setViewportSize({ width: 320, height: 640 });
    await noHorizontalScroll(page, "catálogo 320px");
    await page.getByRole("button", { name: "Imprimir ou salvar em PDF" }).waitFor();
    await page.close();
  });

  await check("IA: cadastro por mensagem preenche o formulário para revisão e gera divulgação", async () => {
    await panel.goto(url + "/painel#produtos");
    await panel.locator(".product-item").first().waitFor();
    await panel.getByRole("button", { name: "Novo produto" }).click();
    const dialog = panel.locator("#product-dialog");
    await dialog.locator("#ai-box").waitFor();
    await dialog.getByLabel("Descreva o produto como você falaria no WhatsApp").fill("saia midi plissada P e M 89,90");
    await dialog.getByRole("button", { name: "Gerar cadastro" }).click();
    await dialog.locator("#ai-note", { hasText: "Sugestão da IA aplicada" }).waitFor();
    assert.equal(await dialog.getByLabel("Nome do produto").inputValue(), "Saia Midi Plissada");
    assert.equal(await dialog.getByLabel("Preço (R$)", { exact: true }).inputValue(), "89,90");
    assert.equal(await dialog.locator("#variant-rows .variant-row").count(), 2);
    assert.equal(await dialog.locator("#product-form .ai-filled").count() >= 3, true);
    await noDialogOverflow(dialog, "IA no cadastro");
    await shot(panel, "18-ia-cadastro-mobile");
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    assert.equal(await panel.locator(".product-item", { hasText: "Saia Midi Plissada" }).count(), 0, "nada salvo sem confirmação");

    await panel.goto(url + "/painel#divulgacao");
    const card = panel.locator("#ai-campaign-card");
    await card.waitFor();
    await card.getByLabel("O que você quer divulgar?").fill("promoção de fim de semana");
    await card.getByRole("button", { name: "Gerar textos" }).click();
    await card.locator("textarea", { hasText: "Oferta especial" }).waitFor();
    assert.match(await card.locator("#campaign-out").textContent(), /Gerado por IA/);
    await noHorizontalScroll(panel, "divulgação IA");
  });

  await check("carrinho abandonado com autorização aparece no painel para chamar no WhatsApp", async () => {
    const buyerCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await buyerCtx.newPage();
    watch(page, "carrinho");
    await page.goto(url + "/loja/moda-da-ana");
    const card = page.locator("#products .product", { hasText: "Vestido Floral" });
    await card.getByRole("button", { name: "Adicionar" }).click();
    await page.locator("#cart-bar").click();
    const dialog = page.locator("#cart-dialog");
    await dialog.getByLabel("Nome").fill("Lia Indecisa");
    await dialog.getByLabel("Telefone / WhatsApp").fill("(54) 97777-1111");
    const saved = page.waitForResponse((r) => r.url().includes("/api/cart-reminder/") && r.request().method() === "PUT");
    await dialog.getByLabel(/a loja pode me chamar no WhatsApp/).check();
    assert.equal((await saved).status(), 200);
    await buyerCtx.close();
    // Simula a passagem de 40 minutos.
    await env.DB.prepare("UPDATE abandoned_carts SET updated_at=datetime('now','-40 minutes')").run();
    await panel.goto(url + "/painel#pedidos");
    await panel.locator("#order-filters").getByRole("button", { name: "Carrinhos abandonados" }).click();
    const item = panel.locator(".order.abandoned", { hasText: "Lia Indecisa" });
    await item.waitFor();
    assert.match(await item.getByRole("link", { name: "Chamar no WhatsApp" }).getAttribute("href"), /^https:\/\/wa\.me\/5554977771111\?text=.*Vestido%20Floral/);
    await noHorizontalScroll(panel, "carrinhos abandonados");
    await item.getByRole("button", { name: "Descartar" }).click();
    await panel.locator("#order-list", { hasText: "Nenhum carrinho abandonado" }).waitFor();
    await panel.locator("#order-filters").getByRole("button", { name: "Todos" }).click();
  });

  await check("PDV: venda no balcão pelo botão de ação, troco, comprovante e baixa no estoque", async () => {
    const created = await panel.request.post(url + "/api/products", {
      headers: { Origin: url, "Content-Type": "application/json" },
      data: { name: "Caneca Balcão", price_cents: 2500, stock: 5, barcode: "7890000000017", active: false },
    });
    assert.equal(created.status(), 201);
    await panel.goto(url + "/painel#inicio");
    await panel.locator("#fab").click();
    await panel.locator("#quick-dialog").getByRole("button", { name: /Registrar venda/ }).click();
    const dlg = panel.locator("#sale-dialog");
    await dlg.getByLabel("Buscar produto").fill("7890000000017");
    await dlg.getByLabel("Buscar produto").press("Enter"); // como um leitor de código de barras
    await dlg.locator(".sale-line", { hasText: "Caneca Balcão" }).waitFor();
    await dlg.getByRole("button", { name: "Aumentar Caneca Balcão" }).click();
    await dlg.getByRole("radio", { name: "Dinheiro" }).click();
    await dlg.getByLabel("Valor recebido (R$)").fill("60");
    await dlg.locator("#cash-change", { hasText: "Troco: R$" }).waitFor();
    assert.doesNotMatch(await dlg.locator("#sale-sum").textContent(), /null|undefined/);
    await noHorizontalScroll(panel, "pdv");
    await shot(panel, "19-pdv-mobile");
    await dlg.getByRole("button", { name: /Finalizar venda · R\$\s?50,00/ }).click();
    await dlg.locator("#receipt", { hasText: "não é documento fiscal" }).waitFor();
    assert.match(await dlg.locator("#receipt").textContent(), /Troco.*R\$\s?10,00/);
    await dlg.getByRole("button", { name: "Nova venda" }).click();
    await dlg.locator("[data-close]").click();
    const product = (await panel.request.get(url + "/api/products").then((r) => r.json())).find((p) => p.name === "Caneca Balcão");
    assert.equal(product.stock, 3);
    await panel.goto(url + "/painel#pedidos");
    await panel.locator("#order-filters").getByRole("button", { name: "No balcão" }).click();
    await panel.locator(".order", { hasText: "Caneca Balcão" }).filter({ hasText: "Balcão" }).waitFor();
    await panel.locator("#order-filters").getByRole("button", { name: "Todos" }).click();
  });

  await check("financeiro: devolução, conta a prazo, despesa e calculadora de preço", async () => {
    const api = (path, data) => panel.request.post(url + path, { headers: { Origin: url, "Content-Type": "application/json" }, data });
    // Devolução da venda no balcão do passo anterior.
    await panel.goto(url + "/painel#pedidos");
    await panel.locator("#order-filters").getByRole("button", { name: "No balcão" }).click();
    const sold = panel.locator(".order", { hasText: "Caneca Balcão" }).first();
    await sold.getByRole("button", { name: "Devolução" }).click();
    const ret = panel.locator("#return-dialog");
    await ret.getByRole("button", { name: "Aumentar devolução de Caneca Balcão" }).click();
    await ret.locator("#return-value", { hasText: "R$" }).waitFor();
    await ret.getByRole("button", { name: "Registrar devolução" }).click();
    await panel.locator(".order", { hasText: "1 devolvido(s)" }).first().waitFor();
    const caneca = (await panel.request.get(url + "/api/products").then((r) => r.json())).find((p) => p.name === "Caneca Balcão");
    assert.equal(caneca.stock, 4);
    // Venda a prazo e recebimento.
    const sale = await api("/api/sales", { id: crypto.randomUUID(), items: [{ id: caneca.id, quantity: 1 }], customer_name: "Seu Jorge", customer_phone: "54988881111", payments: [{ method: "account", amount_cents: 2500 }] });
    assert.equal(sale.status(), 201);
    await panel.locator("#order-filters").getByRole("button", { name: "A receber" }).click();
    const row = panel.locator(".receivable-row", { hasText: "Seu Jorge" });
    await row.getByRole("button", { name: "Receber" }).click();
    await panel.locator("#receive-dialog").getByRole("button", { name: "Confirmar recebimento" }).click();
    await panel.locator("#order-list", { hasText: "Nenhuma venda a prazo em aberto" }).waitFor();
    await panel.locator("#order-filters").getByRole("button", { name: "Todos" }).click();
    // Despesa no resumo.
    await panel.goto(url + "/painel#inicio");
    await panel.locator("#expense-box summary").click();
    const ef = panel.locator("#expense-form");
    await ef.getByLabel("Descrição").fill("Sacolas");
    await ef.getByLabel("Valor (R$)").fill("12,50");
    await ef.getByRole("button", { name: "Salvar despesa" }).click();
    await panel.locator("#expense-list .row", { hasText: "Sacolas" }).waitFor();
    await panel.locator("#kpis .kpi", { hasText: "Resultado estimado" }).filter({ hasText: "12,50" }).waitFor();
    await noHorizontalScroll(panel, "financeiro");
    // Calculadora de preço no cadastro.
    await panel.goto(url + "/painel#produtos");
    await panel.locator(".product-item", { hasText: "Caneca Balcão" }).click();
    const pf = panel.locator("#product-form");
    // A seção já abre sozinha quando o produto tem código de barras.
    if (!(await pf.locator("#product-advanced").evaluate((d) => d.open))) await pf.locator("#product-advanced > summary").click();
    await pf.getByLabel("Preço de custo (R$)").fill("10,00");
    await pf.locator("#price-calc summary").click();
    await pf.getByLabel("Margem desejada (%)").fill("50");
    await pf.locator("#calc-result", { hasText: "R$ 20,00" }).waitFor();
    await pf.getByRole("button", { name: "Usar este preço" }).click();
    assert.equal(await pf.getByLabel("Preço (R$)").inputValue(), "20,00");
    await pf.getByRole("button", { name: "Cancelar" }).click();
  });

  await check("estoque: fornecedor, entrada com custo, perda, inventário e Preciso repor", async () => {
    await panel.goto(url + "/painel#produtos");
    await panel.locator("#supplier-card > summary").click();
    const sf = panel.locator("#supplier-form");
    await sf.getByLabel("Nome do fornecedor").fill("Cerâmica Serra");
    await sf.getByLabel("WhatsApp do fornecedor").fill("(54) 98877-6655");
    await sf.getByRole("button", { name: "Adicionar fornecedor" }).click();
    await panel.locator("#supplier-list .row", { hasText: "Cerâmica Serra" }).waitFor();
    // Entrada: 6 canecas a R$ 9,00 (havia 3 em estoque).
    await panel.getByRole("button", { name: "Movimentar estoque" }).click();
    const dlg = panel.locator("#stock-dialog");
    await dlg.getByLabel("Produto").selectOption({ label: "Caneca Balcão" });
    await dlg.locator("#stock-current", { hasText: "Estoque atual: 3" }).waitFor();
    await dlg.getByLabel("Quantidade que chegou").fill("6");
    await dlg.getByLabel("Custo por unidade (R$)").fill("9,00");
    await dlg.getByLabel("Fornecedor").fill("Cerâmica Serra");
    await noHorizontalScroll(panel, "movimentar estoque");
    await dlg.getByRole("button", { name: "Registrar entrada" }).click();
    await panel.locator("#toast", { hasText: "agora 9" }).waitFor();
    let caneca = (await panel.request.get(url + "/api/products").then((r) => r.json())).find((p) => p.name === "Caneca Balcão");
    assert.equal(caneca.stock, 9);
    // Inventário: só 2 encontradas.
    await panel.getByRole("button", { name: "Movimentar estoque" }).click();
    await dlg.getByRole("radio", { name: "Inventário" }).click();
    await dlg.getByLabel("Produto").selectOption({ label: "Caneca Balcão" });
    await dlg.getByLabel("Quantidade contada").fill("2");
    await dlg.getByRole("button", { name: "Salvar contagem" }).click();
    await panel.locator("#toast", { hasText: "-7" }).waitFor();
    caneca = (await panel.request.get(url + "/api/products").then((r) => r.json())).find((p) => p.name === "Caneca Balcão");
    assert.equal(caneca.stock, 2);
    // Preciso repor: a caneca (2 ≤ 3) aparece no grupo do fornecedor, com envio pelo WhatsApp.
    await panel.getByRole("button", { name: /Preciso repor/ }).click();
    const group = panel.locator("#restock-list .restock-group", { hasText: "Cerâmica Serra" });
    await group.locator(".restock-item", { hasText: "Caneca Balcão" }).waitFor();
    await noHorizontalScroll(panel, "preciso repor");
    await shot(panel, "20-preciso-repor-mobile");
    const link = group.getByRole("link", { name: "Enviar ao fornecedor" });
    await link.dispatchEvent("click");
    assert.match(await link.getAttribute("href"), /^https:\/\/wa\.me\/5554988776655\?text=.*Caneca%20Balc/);
    await panel.locator("#restock-dialog [data-close]").click();
  });

  await check("cadastro: exportar e importar planilha, editar vários e duplicar produto", async () => {
    await panel.goto(url + "/painel#produtos");
    await panel.locator(".product-item").first().waitFor();
    // Exportar: o CSV traz os produtos com cabeçalho em português.
    const [download] = await Promise.all([panel.waitForEvent("download"), panel.getByRole("button", { name: "Exportar planilha" }).click()]);
    const exported = await readFile(await download.path(), "utf8");
    assert.match(exported, /^\uFEFF"Nome";"SKU";"Código de barras"/);
    assert.match(exported, /Caneca Balcão/);
    // Importar: um produto novo e a atualização de um existente pelo SKU.
    await panel.getByRole("button", { name: "Importar planilha" }).click();
    const csv = "Nome;SKU;Categoria;Preço;Custo;Estoque\nGarrafa térmica 500 ml;GAR-500;Utilidades;49,90;25,00;20\nVestido Floral;VES-01;Vestidos;199,90;;\n";
    await panel.locator("#import-file").setInputFiles({ name: "produtos.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await panel.locator("#import-preview", { hasText: "1 novo(s)" }).filter({ hasText: "1 atualizado(s)" }).waitFor();
    await panel.locator("#import-dialog").getByRole("button", { name: "Importar" }).click();
    await panel.locator(".product-item", { hasText: "Garrafa térmica 500 ml" }).waitFor();
    let products = await panel.request.get(url + "/api/products").then((r) => r.json());
    assert.equal(products.find((p) => p.sku === "GAR-500").cost_cents, 2500);
    assert.equal(products.find((p) => p.sku === "VES-01").price_cents, 19990);
    // Planilha com erro mostra a linha e não importa nada.
    await panel.getByRole("button", { name: "Importar planilha" }).click();
    await panel.locator("#import-file").setInputFiles({ name: "ruim.csv", mimeType: "text/csv", buffer: Buffer.from("Nome;Preço\nSem preço;\n") });
    await panel.locator("#import-preview", { hasText: "Linha 2" }).waitFor();
    assert.equal(await panel.locator("#import-confirm").isDisabled(), true);
    await panel.locator("#import-dialog [data-close]").first().click();
    // Editar vários: muda a categoria de dois produtos.
    await panel.getByRole("button", { name: "Editar vários" }).click();
    await panel.getByLabel("Selecionar Garrafa térmica 500 ml").check();
    await panel.getByLabel("Selecionar Caneca Balcão").check();
    await panel.locator("#bulk-count", { hasText: "2 selecionado(s)" }).waitFor();
    await panel.locator("#bulk-value").fill("Cozinha");
    await noHorizontalScroll(panel, "editar vários");
    await panel.getByRole("button", { name: "Aplicar" }).click();
    await panel.locator("#toast", { hasText: "2 produto(s) atualizado(s)" }).waitFor();
    products = await panel.request.get(url + "/api/products").then((r) => r.json());
    assert.deepEqual(products.filter((p) => p.category === "Cozinha").map((p) => p.name).sort(), ["Caneca Balcão", "Garrafa térmica 500 ml"]);
    await panel.getByRole("button", { name: "Concluir seleção" }).click();
    // Duplicar.
    await panel.locator(".product-item", { hasText: "Garrafa térmica 500 ml" }).click();
    await panel.locator("#product-dialog").getByRole("button", { name: "Duplicar" }).click();
    const pf = panel.locator("#product-form");
    assert.equal(await pf.getByLabel("Nome do produto").inputValue(), "Garrafa térmica 500 ml (cópia)");
    await pf.getByRole("button", { name: "Salvar produto" }).click();
    await panel.locator(".product-item", { hasText: "Garrafa térmica 500 ml (cópia)" }).waitFor();
  });

  await check("cadastro por várias fotos com IA e etiquetas com código de barras", async () => {
    await panel.goto(url + "/painel#produtos");
    await panel.locator("#open-photos").waitFor();
    await panel.locator("#photos-input").setInputFiles([
      { name: "a.png", mimeType: "image/png", buffer: PNG },
      { name: "b.png", mimeType: "image/png", buffer: PNG },
    ]);
    const dlg = panel.locator("#drafts-dialog");
    await dlg.locator(".draft .status", { hasText: "Sugestão pronta" }).nth(1).waitFor();
    // Sem preço não salva: o preço é sempre do lojista.
    await dlg.getByRole("button", { name: "Salvar produtos" }).click();
    await panel.locator("#toast", { hasText: "Informe o preço" }).waitFor();
    await dlg.getByLabel("Nome do produto").nth(1).fill("Saia Midi Plissada Azul");
    await dlg.getByLabel("Preço (R$)").nth(0).fill("89,90");
    await dlg.getByLabel("Preço (R$)").nth(1).fill("94,90");
    await noHorizontalScroll(panel, "cadastro por fotos");
    await dlg.getByRole("button", { name: "Salvar produtos" }).click();
    await panel.locator("#toast", { hasText: "2 produto(s) cadastrado(s)" }).waitFor();
    const products = await panel.request.get(url + "/api/products").then((r) => r.json());
    const saia = products.find((p) => p.name === "Saia Midi Plissada Azul");
    assert.equal(saia.price_cents, 9490);
    assert.equal(saia.images.length, 1);
    // Etiquetas: dois produtos, 2 de cada, com código de barras do SKU/EAN.
    await panel.getByRole("button", { name: "Editar vários" }).click();
    await panel.getByLabel("Selecionar Garrafa térmica 500 ml", { exact: true }).check();
    await panel.getByLabel("Selecionar Caneca Balcão").check();
    await panel.locator("#bulk-action").selectOption("labels");
    await panel.getByRole("button", { name: "Aplicar" }).click();
    const labels = panel.locator("#labels-dialog");
    await labels.getByLabel("Etiquetas por item").fill("2");
    await labels.locator(".label").nth(3).waitFor();
    assert.equal(await labels.locator(".label").count(), 4);
    assert.equal(await labels.locator(".label svg.barcode").count(), 4);
    assert.match(await labels.locator("#labels-note").textContent(), /4 etiqueta/);
    await noHorizontalScroll(panel, "etiquetas");
    await shot(panel, "21-etiquetas-mobile");
    await labels.locator("[data-close]").first().click();
    await panel.getByRole("button", { name: "Concluir seleção" }).click();
  });

  await check("vitrine premium: modelo, aviso, horário, filtros, favoritos, relacionados e acompanhamento", async () => {
    await panel.goto(url + "/painel#loja");
    const sf = panel.locator("#settings");
    await sf.getByLabel("Modelo da vitrine").selectOption("roupas");
    assert.match(await panel.locator("#template-preview").getAttribute("href"), /\?modelo=roupas$/);
    await sf.getByLabel("Aviso no topo da vitrine").fill("Frete grátis acima de R$ 150");
    // Abre todos os dias, o dia inteiro: a vitrine mostra "Aberto agora".
    for (const box of await panel.locator("#hours-editor [data-day]").all()) await box.check();
    for (const input of await panel.locator("#hours-editor [data-open]").all()) await input.fill("00:00");
    for (const input of await panel.locator("#hours-editor [data-close-time]").all()) await input.fill("23:59");
    await noHorizontalScroll(panel, "aparência e horário");
    await sf.getByRole("button", { name: "Salvar alterações" }).click();
    await panel.locator("#toast", { hasText: "Configurações salvas" }).waitFor();

    // Contexto novo: a vitrine pode ficar até 15 s em cache no navegador.
    const visitorCtx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    const page = await visitorCtx.newPage();
    watch(page, "vitrine premium");
    await page.goto(url + "/loja/moda-da-ana");
    await page.locator("#announce", { hasText: "Frete grátis acima de R$ 150" }).waitFor();
    assert.ok(await page.evaluate(() => document.body.classList.contains("tpl-roupas")));
    await page.locator("#store-hours.open", { hasText: "Aberto agora" }).waitFor();
    // Favoritos e filtro.
    await page.locator("#products .product", { hasText: "Vestido Floral" }).getByRole("button", { name: "Favoritar: Vestido Floral" }).click();
    await page.locator("#quick-filters").getByRole("button", { name: "Favoritos (1)" }).click();
    assert.equal(await page.locator("#products .product").count(), 1);
    await page.locator("#quick-filters").getByRole("button", { name: "Favoritos (1)" }).click();
    // Ordenar pelo menor preço e filtrar por faixa.
    await page.locator("#sort").selectOption("price-asc");
    const prices = await page.locator("#products .product:not(.soldout) .price").allTextContents();
    // Primeiro valor de cada cartão (o preço atual; o antigo vem riscado depois).
    const cents = prices.map((t) => Number(t.match(/R\$\s?([\d.]+,\d{2})/)[1].replace(/\./g, "").replace(",", ".")));
    assert.deepEqual([...cents].sort((a, b) => a - b), cents);
    await page.locator("#price-range").selectOption("20000-");
    assert.equal(await page.locator("#products .product").count(), 0);
    await page.locator("#price-range").selectOption("");
    // Produto relacionado (mesma categoria ou destaque).
    await page.locator("#products .product", { hasText: "Saia Midi Plissada Azul" }).locator(".product-media").click();
    await page.locator("#pd-related .related-item").first().waitFor();
    await noHorizontalScroll(page, "vitrine premium");
    await shot(page, "22-vitrine-premium-mobile");
    await page.locator("#product-dialog [data-close]").click();
    // Prévia de outro modelo sem salvar.
    await page.goto(url + "/loja/moda-da-ana?modelo=eletronicos");
    await page.locator("#preview-bar", { hasText: "Prévia do modelo" }).waitFor();
    assert.ok(await page.evaluate(() => document.body.classList.contains("tpl-eletronicos")));
    // Acompanhamento do pedido pelo link secreto.
    const id = (await panel.request.get(url + "/api/products").then((r) => r.json())).find((p) => p.name === "Saia Midi Plissada Azul").id;
    const order = await page.request.post(`${url}/api/order-request/moda-da-ana`, {
      headers: { Origin: url, "Content-Type": "application/json" },
      data: { customer_name: "Bia Rastreio", customer_phone: "54955554444", fulfillment: "pickup", items: [{ id, quantity: 1 }] },
    }).then((r) => r.json());
    assert.ok(order.tracking_url, JSON.stringify(order));
    await page.goto(url + order.tracking_url);
    await page.locator("#status-label", { hasText: "aguardando confirmação" }).waitFor();
    assert.match(await page.locator("#order-code").textContent(), /Bia$/);
    assert.ok(!(await page.content()).includes("54955554444"));
    await noHorizontalScroll(page, "acompanhamento");
    await shot(page, "23-acompanhamento-mobile");
    await visitorCtx.close();
  });

  await check("divulgação: arte de oferta em 3 formatos e QR Codes da loja, produto e categoria", async () => {
    await panel.goto(url + "/painel#divulgacao");
    const sel = panel.locator("#art-product");
    await sel.locator("option", { hasText: "Vestido Floral" }).waitFor({ state: "attached" });
    await sel.selectOption(await sel.locator("option", { hasText: "Vestido Floral" }).getAttribute("value"));
    // A arte tem o tamanho exato de cada formato.
    for (const [label, w, hgt] of [["Feed 4:5", 1080, 1350], ["Status 9:16", 1080, 1920], ["Quadrado", 1080, 1080]]) {
      await panel.locator("#art-formats").getByRole("radio", { name: label }).click();
      await panel.waitForFunction(([ww, hh]) => { const c = document.getElementById("art-canvas"); return c.width === ww && c.height === hh; }, [w, hgt]);
    }
    await panel.getByLabel("Chamada").fill("Só neste fim de semana");
    const [download] = await Promise.all([panel.waitForEvent("download"), panel.getByRole("button", { name: "Baixar imagem" }).click()]);
    assert.match(download.suggestedFilename(), /^arte-moda-da-ana-square\.png$/);
    if (SHOTS) await download.saveAs(`${SHOTS}/25-arte-quadrada.png`);
    const png = await readFile(await download.path());
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(png.readUInt32BE(16), 1080);
    assert.equal(png.readUInt32BE(20), 1080);
    // A arte não foi "contaminada" por imagem de outra origem (o download funcionou).
    await noHorizontalScroll(panel, "divulgação");
    await shot(panel, "24-divulgacao-mobile");
    // QR Codes.
    await panel.locator("#qr-preview svg").waitFor();
    assert.match(await panel.locator("#qr-url").textContent(), /\/loja\/moda-da-ana$/);
    await panel.getByLabel("Levar para").selectOption("category");
    await panel.locator("#qr-url", { hasText: "?categoria=" }).waitFor();
    const categoryLink = await panel.locator("#qr-url").textContent();
    await panel.getByLabel("Levar para").selectOption("product");
    await panel.locator("#qr-url", { hasText: "/p/" }).waitFor();
    const [qrFile] = await Promise.all([panel.waitForEvent("download"), panel.getByRole("button", { name: "Baixar PNG" }).click()]);
    assert.match(qrFile.suggestedFilename(), /^qrcode-moda-da-ana\.png$/);
    // O link de categoria abre a vitrine já filtrada.
    // Celular de um cliente que escaneou o QR Code (sem nada em cache).
    const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    const visitor = await phone.newPage();
    await visitor.goto(categoryLink);
    const cat = decodeURIComponent(categoryLink.split("categoria=")[1]);
    await visitor.locator("#all-title", { hasText: cat }).waitFor();
    await phone.close();
  });

  await check("logout encerra a sessão", async () => {
    await panel.getByRole("button", { name: "Sair" }).click();
    await panel.locator("#auth").waitFor();
    await panel.reload();
    await panel.locator("#login").waitFor();
  });

  await check("lojista exclui a própria loja definitivamente", async () => {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    watch(page, "exclusão");
    await page.goto(url + "/painel#cadastro");
    const form = page.locator("#register");
    await form.getByLabel("Nome da loja").fill("Loja Temporaria");
    await form.getByLabel("E-mail").fill("temp@exemplo.com.br");
    await form.getByLabel("Senha").fill("senha-forte-123");
    await form.getByRole("checkbox").check();
    await form.getByRole("button", { name: "Criar loja grátis" }).click();
    await page.locator("#onboarding").waitFor();
    await page.goto(url + "/painel#loja");
    await page.getByRole("button", { name: "Excluir loja" }).click();
    const dialog = page.locator("#delete-store-dialog");
    await dialog.getByLabel(/Digite o endereço/).fill("loja-temporaria");
    await dialog.getByLabel("Sua senha").fill("senha-forte-123");
    await noDialogOverflow(dialog, "exclusão da loja");
    await dialog.getByRole("button", { name: "Excluir definitivamente" }).click();
    await page.locator("#auth-error", { hasText: "foram excluídos" }).waitFor();
    assert.equal((await page.request.get(url + "/loja/loja-temporaria")).status(), 404);
    await ctx.close();
  });

  await check("páginas de privacidade e termos", async () => {
    for (const [path, title] of [["/privacidade", "Política de Privacidade"], ["/termos", "Termos de Uso"]]) {
      await panel.goto(url + path);
      await panel.getByRole("heading", { level: 1, name: title }).waitFor();
      await noHorizontalScroll(panel, path);
    }
  });

  await check("nenhum erro de console ou violação de CSP", async () => {
    assert.deepEqual(errors, []);
  });

  console.log(`\n${results.length} verificações de ponta a ponta aprovadas.`);
} catch (error) {
  console.error(`FALHOU em "${step}":`, error.message);
  if (errors.length) console.error("Erros de console:", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
