// Financeiro simplificado: contas a receber, devoluções e despesas.
// Tudo é registro do lojista (não movimenta dinheiro de verdade).

import { HttpError, json, readJson } from "../lib/http.js";
import { audit } from "../lib/session.js";
import * as v from "../lib/validate.js";
import { PAYMENT_METHODS } from "./sales.js";

const CASH_METHODS = ["pix", "cash", "credit", "debit"];
const brl = (cents) => (cents / 100).toFixed(2).replace(".", ",");

// ---------- Contas a receber ----------

export async function listReceivables(request, env, session) {
  const rows = (await env.DB.prepare(
    `SELECT id,customer_name,customer_phone,total_cents,receivable_cents,created_at
       FROM orders WHERE store_id=? AND status='completed' AND receivable_cents>0
      ORDER BY created_at LIMIT 500`,
  ).bind(session.store.id).all()).results;
  const received = (await env.DB.prepare(
    "SELECT order_id,amount_cents,method,created_at FROM receivable_payments WHERE store_id=? ORDER BY created_at",
  ).bind(session.store.id).all()).results;
  const byOrder = new Map();
  for (const r of received) {
    if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, []);
    byOrder.get(r.order_id).push(r);
  }
  return json({
    total_cents: rows.reduce((s, r) => s + r.receivable_cents, 0),
    items: rows.map((r) => ({ ...r, code: r.id.slice(0, 8).toUpperCase(), received: byOrder.get(r.id) || [] })),
  });
}

// POST /api/receivables/:id — baixa (parcial ou total) atômica do valor a receber.
export async function receivePayment(request, env, session, params) {
  const db = env.DB;
  const orderId = v.id(params.id);
  const body = await readJson(request);
  const amount = v.cents(body.amount_cents, "valor recebido");
  if (amount <= 0) throw new HttpError(400, "Informe o valor recebido");
  if (!CASH_METHODS.includes(body.method)) throw new HttpError(400, "Forma de pagamento inválida");
  const paymentId = crypto.randomUUID();
  // O INSERT e o UPDATE só acontecem se ainda houver saldo suficiente.
  const [insert] = await db.batch([
    db.prepare(
      `INSERT INTO receivable_payments(id,store_id,order_id,amount_cents,method,created_by)
       SELECT ?,store_id,id,?,?,? FROM orders WHERE id=? AND store_id=? AND status='completed' AND receivable_cents>=?`,
    ).bind(paymentId, amount, body.method, session.user.id, orderId, session.store.id, amount),
    db.prepare("UPDATE orders SET receivable_cents=receivable_cents-? WHERE id=? AND store_id=? AND status='completed' AND receivable_cents>=?")
      .bind(amount, orderId, session.store.id, amount),
  ]);
  if (!insert.meta.changes) {
    const order = await db.prepare("SELECT receivable_cents FROM orders WHERE id=? AND store_id=?").bind(orderId, session.store.id).first();
    if (!order) throw new HttpError(404, "Venda não encontrada");
    throw new HttpError(400, `O valor é maior do que falta receber (R$ ${brl(order.receivable_cents)})`);
  }
  await audit(db, { storeId: session.store.id, userId: session.user.id, action: "receivable.paid", target: orderId, detail: `${brl(amount)} ${body.method}` });
  const left = await db.prepare("SELECT receivable_cents FROM orders WHERE id=?").bind(orderId).first();
  return json({ ok: true, receivable_cents: left.receivable_cents }, 201);
}

// ---------- Devoluções ----------

const lineKey = (i) => `${i.id}|${i.variant_id || ""}`;

// POST /api/orders/:id/returns — { items: [{id, variant_id?, quantity}], restock, reason }
export async function createReturn(request, env, session, params) {
  const db = env.DB;
  const orderId = v.id(params.id);
  const body = await readJson(request);
  const order = await db.prepare(
    "SELECT id,items_json,subtotal_cents,discount_cents,receivable_cents,status FROM orders WHERE id=? AND store_id=?",
  ).bind(orderId, session.store.id).first();
  if (!order) throw new HttpError(404, "Venda não encontrada");
  if (order.status !== "completed") throw new HttpError(409, "Só vendas concluídas podem ter devolução. Pedidos em aberto podem ser cancelados.");
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) throw new HttpError(400, "Escolha os itens devolvidos");
  const sold = new Map(JSON.parse(order.items_json).map((i) => [lineKey(i), i]));
  const merged = new Map();
  for (const it of body.items) {
    const line = sold.get(lineKey({ id: String(it?.id ?? ""), variant_id: it?.variant_id || "" }));
    if (!line) throw new HttpError(400, "Item não pertence a esta venda");
    const qty = v.quantity(it.quantity, "quantidade devolvida", 10000);
    if (!qty) continue;
    const key = lineKey(line);
    merged.set(key, { line, qty: (merged.get(key)?.qty || 0) + qty });
  }
  if (!merged.size) throw new HttpError(400, "Escolha pelo menos um item para devolver");
  // Valor dos itens com o desconto da venda rateado proporcionalmente.
  const factor = order.subtotal_cents ? (order.subtotal_cents - order.discount_cents) / order.subtotal_cents : 1;
  let value = 0;
  let valueWithCost = 0;
  let cost = 0;
  const items = [];
  for (const { line, qty } of merged.values()) {
    const lineValue = Math.round(line.price_cents * qty * factor);
    value += lineValue;
    if (line.cost_cents !== undefined && line.cost_cents !== null) {
      valueWithCost += lineValue;
      cost += line.cost_cents * qty;
    }
    items.push({ id: line.id, ...(line.variant_id ? { variant_id: line.variant_id } : {}), name: line.name, variant_name: line.variant_name, quantity: qty, price_cents: line.price_cents });
  }
  // Se ainda há valor a receber, a devolução abate dele primeiro.
  const credit = Math.min(value, order.receivable_cents);
  const refund = value - credit;
  const restock = body.restock === false ? 0 : 1;
  const reason = v.cleanText(body.reason, 200);
  const id = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO order_returns(id,store_id,order_id,items_json,value_cents,value_with_cost_cents,cost_cents,refund_cents,credit_cents,restock,reason,created_by)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(id, session.store.id, orderId, JSON.stringify(items), value, valueWithCost, cost, refund, credit, restock, reason, session.user.id),
      db.prepare("UPDATE orders SET receivable_cents=receivable_cents-? WHERE id=? AND store_id=? AND receivable_cents>=?")
        .bind(credit, orderId, session.store.id, credit),
    ]);
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("maior que a vendida")) throw new HttpError(409, "A quantidade devolvida passa do que foi vendido (considerando devoluções anteriores)");
    if (message.includes("Devolução inválida")) throw new HttpError(409, "Esta venda não pode receber devolução");
    throw error;
  }
  await audit(db, { storeId: session.store.id, userId: session.user.id, action: "order.returned", target: orderId, detail: `${brl(value)}${restock ? " (repõe estoque)" : ""}` });
  return json({ id, value_cents: value, refund_cents: refund, credit_cents: credit, restock: !!restock, items }, 201);
}

// Quantidades já devolvidas por venda (para a lista de vendas).
export async function returnsByOrder(db, storeId) {
  const rows = (await db.prepare("SELECT order_id,items_json,value_cents FROM order_returns WHERE store_id=?").bind(storeId).all()).results;
  const map = new Map();
  for (const r of rows) {
    const entry = map.get(r.order_id) || { value_cents: 0, quantities: {} };
    entry.value_cents += r.value_cents;
    for (const i of JSON.parse(r.items_json)) entry.quantities[lineKey(i)] = (entry.quantities[lineKey(i)] || 0) + i.quantity;
    map.set(r.order_id, entry);
  }
  return map;
}

// ---------- Despesas ----------

function day(value, label) {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw new HttpError(400, `Data inválida para ${label}`);
  return text;
}

export async function listExpenses(request, env, session) {
  const params = new URL(request.url).searchParams;
  const start = params.get("start") ? day(params.get("start"), "início") : "0000-01-01";
  const end = params.get("end") ? day(params.get("end"), "fim") : "9999-12-31";
  const rows = (await env.DB.prepare(
    `SELECT id,description,category,amount_cents,paid_on,created_at FROM expenses
      WHERE store_id=? AND paid_on BETWEEN ? AND ? ORDER BY paid_on DESC, created_at DESC LIMIT 500`,
  ).bind(session.store.id, start, end).all()).results;
  return json({ total_cents: rows.reduce((s, r) => s + r.amount_cents, 0), items: rows });
}

export async function createExpense(request, env, session) {
  const body = await readJson(request);
  const description = v.requiredText(body.description, 120, "a descrição da despesa");
  const amount = v.cents(body.amount_cents, "valor da despesa");
  if (amount <= 0) throw new HttpError(400, "Informe o valor da despesa");
  const paidOn = day(body.paid_on, "pagamento");
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO expenses(id,store_id,description,category,amount_cents,paid_on,created_by) VALUES(?,?,?,?,?,?,?)")
    .bind(id, session.store.id, description, v.cleanText(body.category, 60), amount, paidOn, session.user.id).run();
  await audit(env.DB, { storeId: session.store.id, userId: session.user.id, action: "expense.created", target: id, detail: `${description}: ${brl(amount)}` });
  return json({ id }, 201);
}

export async function deleteExpense(request, env, session, params) {
  const id = v.id(params.id);
  const result = await env.DB.prepare("DELETE FROM expenses WHERE id=? AND store_id=?").bind(id, session.store.id).run();
  if (!result.meta.changes) throw new HttpError(404, "Despesa não encontrada");
  await audit(env.DB, { storeId: session.store.id, userId: session.user.id, action: "expense.deleted", target: id });
  return json({ ok: true });
}

export { PAYMENT_METHODS };
