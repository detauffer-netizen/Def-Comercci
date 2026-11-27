// Estoque avançado: entradas, perdas, ajustes, inventário, fornecedores e
// a lista "Preciso repor". O estoque muda pelos gatilhos de stock_adjustments.

import { HttpError, json, readJson } from "../lib/http.js";
import { audit } from "../lib/session.js";
import * as v from "../lib/validate.js";
import { DEFAULT_MIN_STOCK } from "./dashboard.js";

const KIND_LABEL = { entry: "Entrada", loss: "Perda", adjust: "Ajuste", count: "Inventário" };

function stockError(error) {
  const message = String(error?.message || error);
  if (message.includes("CHECK") || message.includes("constraint failed")) throw new HttpError(409, "O estoque ficaria negativo. Confira a quantidade.");
  if (message.includes("Produto não encontrado")) throw new HttpError(404, "Produto não encontrado");
  if (message.includes("Escolha a variação")) throw new HttpError(400, "Este produto tem variações: escolha qual delas movimentar");
  if (message.includes("Variação não encontrada")) throw new HttpError(404, "Variação não encontrada");
  throw error;
}

// POST /api/stock-adjustments
export async function createAdjustment(request, env, session) {
  const db = env.DB;
  const storeId = session.store.id;
  const body = await readJson(request);
  const productId = v.id(body.product_id);
  const variantId = body.variant_id ? v.id(body.variant_id) : null;
  const kind = body.kind;
  if (!KIND_LABEL[kind]) throw new HttpError(400, "Tipo de movimentação inválido");
  const reason = v.cleanText(body.reason, 200);
  const supplier = v.cleanText(body.supplier, 100);
  const unitCost = kind === "entry" ? v.cents(body.unit_cost_cents, "custo unitário", { optional: true }) : null;
  const product = await db.prepare("SELECT name,cost_cents,supplier FROM products WHERE id=? AND store_id=?").bind(productId, storeId).first();
  if (!product) throw new HttpError(404, "Produto não encontrado");
  const id = crypto.randomUUID();
  const label = variantId
    ? `${product.name} · ${(await db.prepare("SELECT name FROM product_variants WHERE id=? AND store_id=?").bind(variantId, storeId).first())?.name || ""}`
    : product.name;
  try {
    if (kind === "count") {
      const counted = v.quantity(body.quantity, "quantidade contada");
      // Diferença calculada no banco, na mesma instrução (sem corrida com vendas).
      await db.prepare(
        `INSERT INTO stock_adjustments(id,store_id,product_id,variant_id,product_name,kind,delta,reason,created_by)
         SELECT ?,?,?,?,?,'count',? - COALESCE(
           (SELECT stock FROM product_variants WHERE id=? AND store_id=?),
           (SELECT stock FROM products WHERE id=? AND store_id=? AND ? IS NULL)), ?, ?`,
      ).bind(id, storeId, productId, variantId, label, counted, variantId, storeId, productId, storeId, variantId, reason, session.user.id).run();
    } else {
      let delta;
      if (kind === "adjust") {
        delta = Number(body.delta);
        if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 1_000_000) throw new HttpError(400, "Informe quanto somar ou tirar do estoque");
      } else {
        const qty = v.quantity(body.quantity, "quantidade");
        if (!qty) throw new HttpError(400, "Informe a quantidade");
        delta = kind === "entry" ? qty : -qty;
      }
      await db.prepare(
        `INSERT INTO stock_adjustments(id,store_id,product_id,variant_id,product_name,kind,delta,unit_cost_cents,supplier,reason,created_by)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(id, storeId, productId, variantId, label, kind, delta, unitCost, supplier, reason, session.user.id).run();
    }
  } catch (error) {
    stockError(error);
  }
  const row = await db.prepare("SELECT delta,stock_after FROM stock_adjustments WHERE id=?").bind(id).first();
  // Entrada com custo: atualiza o custo do produto pela média ponderada.
  if (kind === "entry" && unitCost !== null && body.update_cost !== false) {
    const stockBefore = (await db.prepare("SELECT stock FROM products WHERE id=?").bind(productId).first()).stock - row.delta;
    const cost = product.cost_cents !== null && stockBefore > 0
      ? Math.round((stockBefore * product.cost_cents + row.delta * unitCost) / (stockBefore + row.delta))
      : unitCost;
    await db.prepare("UPDATE products SET cost_cents=? WHERE id=? AND store_id=?").bind(cost, productId, storeId).run();
  }
  // Primeira compra com fornecedor informado: o produto passa a apontar para ele.
  if (kind === "entry" && supplier && !product.supplier) {
    await db.prepare("UPDATE products SET supplier=? WHERE id=? AND store_id=? AND supplier=''").bind(supplier, productId, storeId).run();
  }
  await audit(db, { storeId, userId: session.user.id, action: `stock.${kind}`, target: productId, detail: `${label}: ${row.delta > 0 ? "+" : ""}${row.delta}` });
  return json({ id, kind, delta: row.delta, stock_after: row.stock_after }, 201);
}

export async function listAdjustments(request, env, session) {
  const rows = (await env.DB.prepare(
    `SELECT id,product_id,variant_id,product_name,kind,delta,stock_after,unit_cost_cents,supplier,reason,created_at
       FROM stock_adjustments WHERE store_id=? ORDER BY created_at DESC, rowid DESC LIMIT 200`,
  ).bind(session.store.id).all()).results;
  return json(rows.map((r) => ({ ...r, kind_label: KIND_LABEL[r.kind] })));
}

// ---------- Fornecedores ----------

function supplierInput(body) {
  return {
    name: v.requiredText(body.name, 100, "o nome do fornecedor"),
    phone: v.phone(body.phone, { optional: true }),
    notes: v.cleanText(body.notes, 300),
  };
}

const duplicate = (error) => {
  if (String(error?.message || error).includes("UNIQUE")) throw new HttpError(409, "Já existe um fornecedor com este nome");
  throw error;
};

export async function listSuppliers(request, env, session) {
  const rows = (await env.DB.prepare(
    `SELECT s.id,s.name,s.phone,s.notes,
            (SELECT COUNT(*) FROM products p WHERE p.store_id=s.store_id AND p.supplier = s.name COLLATE NOCASE) AS products
       FROM suppliers s WHERE s.store_id=? ORDER BY s.name COLLATE NOCASE`,
  ).bind(session.store.id).all()).results;
  return json(rows);
}

export async function createSupplier(request, env, session) {
  const s = supplierInput(await readJson(request));
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO suppliers(id,store_id,name,phone,notes) VALUES(?,?,?,?,?)")
    .bind(id, session.store.id, s.name, s.phone, s.notes).run().catch(duplicate);
  await audit(env.DB, { storeId: session.store.id, userId: session.user.id, action: "supplier.created", target: id, detail: s.name });
  return json({ id }, 201);
}

export async function updateSupplier(request, env, session, params) {
  const id = v.id(params.id);
  const s = supplierInput(await readJson(request));
  const old = await env.DB.prepare("SELECT name FROM suppliers WHERE id=? AND store_id=?").bind(id, session.store.id).first();
  if (!old) throw new HttpError(404, "Fornecedor não encontrado");
  await env.DB.batch([
    env.DB.prepare("UPDATE suppliers SET name=?,phone=?,notes=? WHERE id=? AND store_id=?").bind(s.name, s.phone, s.notes, id, session.store.id),
    // Renomear o fornecedor atualiza os produtos ligados a ele.
    env.DB.prepare("UPDATE products SET supplier=? WHERE store_id=? AND supplier = ? COLLATE NOCASE").bind(s.name, session.store.id, old.name),
  ]).catch(duplicate);
  return json({ ok: true });
}

export async function deleteSupplier(request, env, session, params) {
  const id = v.id(params.id);
  const result = await env.DB.prepare("DELETE FROM suppliers WHERE id=? AND store_id=?").bind(id, session.store.id).run();
  if (!result.meta.changes) throw new HttpError(404, "Fornecedor não encontrado");
  return json({ ok: true });
}

// ---------- Preciso repor ----------

// Itens no mínimo ou abaixo, considerando o que está reservado em pedidos
// pendentes. Sugestão: repor até o dobro do mínimo.
export async function restockList(request, env, session) {
  const db = env.DB;
  const storeId = session.store.id;
  const products = (await db.prepare(
    // Inclui produtos ocultos da vitrine: podem ser vendidos no balcão.
    "SELECT id,name,sku,stock,min_stock,cost_cents,supplier FROM products WHERE store_id=?",
  ).bind(storeId).all()).results;
  const variants = (await db.prepare(
    "SELECT id,product_id,name,sku,stock FROM product_variants WHERE store_id=? AND active=1",
  ).bind(storeId).all()).results;
  const reserved = new Map((await db.prepare(
    `SELECT json_extract(j.value,'$.id') || '|' || COALESCE(json_extract(j.value,'$.variant_id'),'') AS k,
            SUM(json_extract(j.value,'$.quantity')) AS q
       FROM orders o, json_each(o.items_json) j WHERE o.store_id=? AND o.status='pending' GROUP BY k`,
  ).bind(storeId).all()).results.map((r) => [r.k, r.q]));
  const suppliers = new Map((await db.prepare("SELECT name,phone FROM suppliers WHERE store_id=?").bind(storeId).all()).results
    .map((s) => [s.name.toLowerCase(), s]));
  const byProduct = new Map();
  for (const x of variants) {
    if (!byProduct.has(x.product_id)) byProduct.set(x.product_id, []);
    byProduct.get(x.product_id).push(x);
  }
  const items = [];
  for (const p of products) {
    const min = p.min_stock ?? DEFAULT_MIN_STOCK;
    const lines = byProduct.get(p.id)?.map((x) => ({ variant_id: x.id, name: `${p.name} · ${x.name}`, sku: x.sku || p.sku, stock: x.stock, key: `${p.id}|${x.id}` }))
      || [{ variant_id: null, name: p.name, sku: p.sku, stock: p.stock, key: `${p.id}|` }];
    for (const l of lines) {
      const held = reserved.get(l.key) || 0;
      const available = l.stock - held;
      if (available > min) continue;
      const target = Math.max(min * 2, min + 1);
      items.push({
        product_id: p.id, variant_id: l.variant_id, name: l.name, sku: l.sku, stock: l.stock, reserved: held, available, min,
        suggested: Math.max(1, target - available), cost_cents: p.cost_cents, supplier: p.supplier,
      });
    }
  }
  const groups = new Map();
  for (const it of items) {
    const key = it.supplier.toLowerCase();
    if (!groups.has(key)) {
      const s = suppliers.get(key);
      groups.set(key, { supplier: it.supplier || "", phone: s?.phone || "", items: [] });
    }
    groups.get(key).items.push(it);
  }
  const list = [...groups.values()]
    .map((g) => ({ ...g, items: g.items.sort((a, b) => a.available - b.available), estimated_cost_cents: g.items.every((i) => i.cost_cents !== null) ? g.items.reduce((s, i) => s + i.cost_cents * i.suggested, 0) : null }))
    .sort((a, b) => (a.supplier ? 0 : 1) - (b.supplier ? 0 : 1) || a.supplier.localeCompare(b.supplier, "pt-BR"));
  return json({ count: items.length, groups: list });
}
