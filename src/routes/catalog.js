// Ferramentas de catálogo: importação por planilha e edição em massa.

import { HttpError, json, readJson } from "../lib/http.js";
import { audit } from "../lib/session.js";
import * as v from "../lib/validate.js";
import { assertWithinLimit } from "../lib/billing.js";

const MAX_IMPORT = 500;

function rowInput(r) {
  const name = v.requiredText(r.name, 120, "o nome do produto");
  const price = v.cents(r.price_cents, "preço");
  const promo = v.cents(r.promo_price_cents, "preço promocional", { optional: true });
  if (promo !== null && promo >= price) throw new HttpError(400, "O preço promocional deve ser menor que o preço normal");
  const sku = v.cleanText(r.sku, 60);
  if (sku && !/^[A-Za-z0-9._\-/]{1,60}$/.test(sku)) throw new HttpError(400, "SKU inválido: use letras, números, ponto, hífen, barra ou sublinhado");
  const barcode = String(r.barcode ?? "").replace(/\s/g, "");
  if (barcode && !/^[0-9A-Za-z-]{4,40}$/.test(barcode)) throw new HttpError(400, "Código de barras inválido");
  return {
    name, price_cents: price, promo_price_cents: promo, sku, barcode,
    stock: r.stock === null || r.stock === undefined || r.stock === "" ? null : v.quantity(r.stock, "estoque"),
    cost_cents: v.cents(r.cost_cents, "preço de custo", { optional: true }),
    min_stock: r.min_stock === null || r.min_stock === undefined || r.min_stock === "" ? null : v.quantity(r.min_stock, "alerta de reposição", 100000),
    category: v.cleanText(r.category, 80),
    supplier: v.cleanText(r.supplier, 100),
    description: v.cleanText(r.description, 2000, { multiline: true }),
    active: r.active === undefined || r.active === null || r.active === "" ? 1 : v.flag(r.active),
  };
}

// POST /api/products/import — { rows: [...], dry_run }
// Atualiza pelo SKU quando ele já existe; senão cria. Tudo ou nada: com
// qualquer linha inválida, nada é gravado e os erros voltam por linha.
export async function importProducts(request, env, session) {
  const db = env.DB;
  const storeId = session.store.id;
  const body = await readJson(request);
  if (!Array.isArray(body.rows) || !body.rows.length) throw new HttpError(400, "A planilha está vazia");
  if (body.rows.length > MAX_IMPORT) throw new HttpError(400, `Importe no máximo ${MAX_IMPORT} produtos por vez`);
  const existing = new Map((await db.prepare("SELECT id,sku,(SELECT COUNT(*) FROM product_variants pv WHERE pv.product_id=products.id) AS variants FROM products WHERE store_id=? AND sku<>''")
    .bind(storeId).all()).results.map((p) => [p.sku.toLowerCase(), p]));
  const errors = [];
  const rows = [];
  const seen = new Set();
  body.rows.forEach((raw, index) => {
    try {
      const r = rowInput(raw || {});
      if (r.sku) {
        const key = r.sku.toLowerCase();
        if (seen.has(key)) throw new HttpError(400, `SKU ${r.sku} repetido na planilha`);
        seen.add(key);
      }
      const match = r.sku ? existing.get(r.sku.toLowerCase()) : null;
      if (!match && r.stock === null) r.stock = 0;
      rows.push({ ...r, match });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      errors.push({ row: index + 2, message: error.message }); // linha 1 = cabeçalho
    }
  });
  const toCreate = rows.filter((r) => !r.match).length;
  if (!errors.length && toCreate) {
    const count = (await db.prepare("SELECT COUNT(*) AS n FROM products WHERE store_id=?").bind(storeId).first()).n;
    // O último produto novo precisa caber no limite do plano.
    await assertWithinLimit(db, storeId, "max_products", count + toCreate - 1, "produtos");
  }
  const summary = { created: toCreate, updated: rows.length - toCreate, errors };
  // Na prévia, linhas com problema são uma resposta normal (não um erro da requisição).
  if (errors.length) return json({ ...summary, valid: false, error: `A planilha tem ${errors.length} linha(s) com problema` }, body.dry_run ? 200 : 400);
  if (body.dry_run) return json({ ...summary, valid: true, dry_run: true });
  const statements = [];
  for (const r of rows) {
    if (r.match) {
      statements.push(db.prepare(
        `UPDATE products SET name=?,price_cents=?,promo_price_cents=?,cost_cents=?,min_stock=?,barcode=?,category=?,supplier=?,description=?,active=?,
                stock = CASE WHEN ? IS NULL OR EXISTS (SELECT 1 FROM product_variants WHERE product_id=products.id) THEN stock ELSE ? END
          WHERE id=? AND store_id=?`,
      ).bind(r.name, r.price_cents, r.promo_price_cents, r.cost_cents, r.min_stock, r.barcode, r.category, r.supplier, r.description, r.active,
        r.stock, r.stock, r.match.id, storeId));
    } else {
      statements.push(db.prepare(
        `INSERT INTO products(id,store_id,name,description,price_cents,promo_price_cents,stock,category,sku,featured,active,position,
                              cost_cents,min_stock,barcode,supplier,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,0,?,0,?,?,?,?,datetime('now'))`,
      ).bind(crypto.randomUUID(), storeId, r.name, r.description, r.price_cents, r.promo_price_cents, r.stock, r.category, r.sku, r.active,
        r.cost_cents, r.min_stock, r.barcode, r.supplier));
    }
  }
  try {
    await db.batch(statements);
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE")) throw new HttpError(409, "Um dos SKUs já é usado por uma variação de outro produto");
    throw error;
  }
  await audit(db, { storeId, userId: session.user.id, action: "product.imported", detail: `${summary.created} novos, ${summary.updated} atualizados` });
  return json(summary, 201);
}

// POST /api/products/bulk — { ids, action, value }
export async function bulkUpdate(request, env, session) {
  const db = env.DB;
  const storeId = session.store.id;
  const body = await readJson(request);
  if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 500) throw new HttpError(400, "Selecione os produtos");
  const ids = [...new Set(body.ids.map((x) => v.id(x)))];
  const list = JSON.stringify(ids);
  const where = "store_id=? AND id IN (SELECT value FROM json_each(?))";
  let statements;
  let detail;
  switch (body.action) {
    case "category": {
      const category = v.cleanText(body.value, 80);
      statements = [db.prepare(`UPDATE products SET category=? WHERE ${where}`).bind(category, storeId, list)];
      detail = `categoria: ${category || "(sem)"}`;
      break;
    }
    case "supplier": {
      const supplier = v.cleanText(body.value, 100);
      statements = [db.prepare(`UPDATE products SET supplier=? WHERE ${where}`).bind(supplier, storeId, list)];
      detail = `fornecedor: ${supplier || "(sem)"}`;
      break;
    }
    case "visibility": {
      const active = v.flag(body.value);
      statements = [db.prepare(`UPDATE products SET active=? WHERE ${where}`).bind(active, storeId, list)];
      detail = active ? "visíveis" : "ocultos";
      break;
    }
    case "price_percent": {
      const pct = Number(body.value);
      if (!Number.isFinite(pct) || pct <= -90 || pct > 500 || pct === 0) throw new HttpError(400, "Informe um percentual entre -90% e 500%");
      const factor = 1 + pct / 100;
      // Promoção que deixaria de ser menor que o preço é mantida proporcional.
      statements = [
        db.prepare(`UPDATE products SET price_cents=CAST(ROUND(price_cents*?) AS INTEGER),
                      promo_price_cents=CASE WHEN promo_price_cents IS NULL THEN NULL ELSE CAST(ROUND(promo_price_cents*?) AS INTEGER) END
                     WHERE ${where}`).bind(factor, factor, storeId, list),
        db.prepare(`UPDATE product_variants SET price_cents=CAST(ROUND(price_cents*?) AS INTEGER)
                     WHERE price_cents IS NOT NULL AND store_id=? AND product_id IN (SELECT value FROM json_each(?))`).bind(factor, storeId, list),
        db.prepare(`UPDATE products SET promo_price_cents=NULL WHERE promo_price_cents>=price_cents AND ${where}`).bind(storeId, list),
      ];
      detail = `preço ${pct > 0 ? "+" : ""}${pct}%`;
      break;
    }
    default:
      throw new HttpError(400, "Ação inválida");
  }
  const results = await db.batch(statements);
  await audit(db, { storeId, userId: session.user.id, action: "product.bulk", detail: `${ids.length} produto(s), ${detail}` });
  return json({ ok: true, updated: results[0].meta.changes });
}
