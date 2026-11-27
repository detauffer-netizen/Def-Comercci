// Teste de ponta a ponta em navegador real (Chromium via Playwright):
// cadastro → produto com foto → configuração → vitrine → carrinho →
// pedido pelo WhatsApp → confirmação no painel com baixa de estoque.
// Também verifica erros de console (inclusive violações de CSP) e rolagem
// horizontal em telas de celular.

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import { startServer } from "./server.js";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const SHOTS = process.env.E2E_SCREENSHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
// PNG 8x8 válido.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGNQTX6NFTEMLQkADGRcwcht3uAAAAAASUVORK5CYII=", "base64");

const { server, url } = await startServer();
const browser = await chromium.launch();
const errors = [];
let step = "início";
const results = [];

function watch(page, label) {
  page.on("console", (msg) => {
    // O 401 de /api/me sem sessão é esperado (é assim que o painel sabe que deve mostrar o login).
    if (msg.type() === "error" && !/status of 401/.test(msg.text())) errors.push(`${label}: ${msg.text()}`);
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

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

try {
  const mobile = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  const panel = await mobile.newPage();
  watch(panel, "painel");

  await check("landing carrega sem erros e leva ao cadastro", async () => {
    await panel.goto(url + "/");
    await panel.getByRole("button", { name: "Catálogo", exact: true }).click();
    await panel.locator("#products button").first().click();
    await panel.getByRole("button", { name: "Início", exact: true }).click();
    await noHorizontalScroll(panel, "landing");
    await shot(panel, "01-landing-mobile");
    await panel.getByRole("link", { name: "Criar minha loja grátis" }).first().click();
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
    assert.match(await panel.locator("#kpis").textContent(), /Clientes1/);
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

  await check("logout encerra a sessão", async () => {
    await panel.getByRole("button", { name: "Sair" }).click();
    await panel.locator("#auth").waitFor();
    await panel.reload();
    await panel.locator("#login").waitFor();
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
