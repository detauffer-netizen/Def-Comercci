// Central de decisões da tela inicial. Tudo calculado com consultas ao banco
// (nada de IA): faturamento, lucro estimado, estoque e recomendações.
// "Venda" = pedido confirmado ou concluído. Dias no horário de Brasília (UTC-3).

import { HttpError, json } from "../lib/http.js";
import { effectivePrice, variantPrice, variantsByProduct } from "./public.js";

const SOLD = "o.status IN ('confirmed','completed')";
const LOCAL_DAY = "date(o.created_at, '-3 hours')";
export const DEFAULT_MIN_STOCK = 3;
const STALE_DAYS = 30;

const localToday = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;

export function periodRange(params, today = localToday()) {
  const period = params.get("period") || "30d";
  if (period === "today") return { period, start: today, end: today };
  if (period === "yesterday") { const y = addDays(today, -1); return { period, start: y, end: y }; }
  if (period === "7d") return { period, start: addDays(today, -6), end: today };
  if (period === "30d") return { period, start: addDays(today, -29), end: today };
  if (period === "custom") {
    const start = params.get("start") || "";
    const end = params.get("end") || "";
    const valid = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
    if (!valid(start) || !valid(end) || start > end) throw new HttpError(400, "Escolha uma data inicial e uma final válidas");
    if (daysBetween(start, end) > 366) throw new HttpError(400, "O período pode ter no máximo 1 ano");
    return { period, start, end };
  }
  throw new HttpError(400, "Período inválido");
}

async function salesTotals(db, storeId, start, end) {
  const orders = await db.prepare(
    `SELECT COUNT(*) AS sales, COALESCE(SUM(o.total_cents),0) AS revenue,
            COALESCE(SUM(o.discount_cents),0) AS discounts, COALESCE(SUM(o.delivery_fee_cents),0) AS delivery_fees
       FROM orders o WHERE o.store_id=? AND ${SOLD} AND ${LOCAL_DAY} BETWEEN ? AND ?`,
  ).bind(storeId, start, end).first();
  const lines = await db.prepare(
    `SELECT COALESCE(SUM(q*p),0) AS items_revenue,
            COALESCE(SUM(CASE WHEN c IS NOT NULL THEN q*p END),0) AS revenue_with_cost,
            COALESCE(SUM(CASE WHEN c IS NOT NULL THEN q*c END),0) AS cogs
       FROM (SELECT json_extract(j.value,'$.quantity') AS q, json_extract(j.value,'$.price_cents') AS p,
                    json_extract(j.value,'$.cost_cents') AS c
               FROM orders o, json_each(o.items_json) j
              WHERE o.store_id=? AND ${SOLD} AND ${LOCAL_DAY} BETWEEN ? AND ?)`,
  ).bind(storeId, start, end).first();
  const returns = await db.prepare(
    `SELECT COALESCE(SUM(value_cents),0) AS value, COALESCE(SUM(value_with_cost_cents),0) AS value_with_cost,
            COALESCE(SUM(cost_cents),0) AS cost, COUNT(*) AS n
       FROM order_returns WHERE store_id=? AND date(created_at,'-3 hours') BETWEEN ? AND ?`,
  ).bind(storeId, start, end).first();
  const expenses = (await db.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS cents FROM expenses WHERE store_id=? AND paid_on BETWEEN ? AND ?",
  ).bind(storeId, start, end).first()).cents;
  // Lucro bruto só sobre os itens com custo informado; o desconto é rateado.
  // Devoluções do período tiram a receita e devolvem o custo dos itens.
  const coverage = lines.items_revenue ? lines.revenue_with_cost / lines.items_revenue : 0;
  const discountShare = lines.items_revenue ? Math.round(orders.discounts * coverage) : 0;
  const gross = lines.revenue_with_cost - lines.cogs - discountShare - (returns.value_with_cost - returns.cost);
  const grossProfit = lines.revenue_with_cost ? gross : null;
  return {
    ...orders,
    average_ticket: orders.sales ? Math.round(orders.revenue / orders.sales) : 0,
    items_revenue: lines.items_revenue,
    cogs: lines.cogs - returns.cost,
    returns_cents: returns.value,
    returns_count: returns.n,
    net_revenue: orders.revenue - returns.value,
    gross_profit: grossProfit,
    cost_coverage: Math.round(coverage * 100),
    expenses_cents: expenses,
    // Resultado = lucro bruto − despesas registradas. É estimativa: depende
    // de custos e despesas estarem completos.
    result_cents: grossProfit === null ? null : grossProfit - expenses,
  };
}

export async function dashboard(request, env, session) {
  const db = env.DB;
  const storeId = session.store.id;
  const { period, start, end } = periodRange(new URL(request.url).searchParams);
  const length = daysBetween(start, end);
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -(length - 1));
  const [current, previous] = await Promise.all([
    salesTotals(db, storeId, start, end),
    salesTotals(db, storeId, prevStart, prevEnd),
  ]);

  const top = (await db.prepare(
    `SELECT json_extract(j.value,'$.id') AS id, json_extract(j.value,'$.name') AS name,
            json_extract(j.value,'$.variant_name') AS variant,
            SUM(json_extract(j.value,'$.quantity')) AS quantity,
            SUM(json_extract(j.value,'$.quantity') * json_extract(j.value,'$.price_cents')) AS revenue
       FROM orders o, json_each(o.items_json) j
      WHERE o.store_id=? AND ${SOLD} AND ${LOCAL_DAY} BETWEEN ? AND ?
      GROUP BY json_extract(j.value,'$.id'), json_extract(j.value,'$.variant_id')
      ORDER BY revenue DESC, quantity DESC LIMIT 5`,
  ).bind(storeId, start, end).all()).results.map((t) => ({
    ...t, share: current.items_revenue ? Math.round((t.revenue / current.items_revenue) * 100) : 0,
  }));

  // Estoque: valor pelo custo, valor de venda e itens para repor.
  const products = (await db.prepare(
    `SELECT id,name,price_cents,promo_price_cents,stock,cost_cents,min_stock,supplier,created_at
       FROM products WHERE store_id=? AND active=1`,
  ).bind(storeId).all()).results;
  const variants = await variantsByProduct(db, storeId, { activeOnly: true });
  let stockCost = 0;
  let stockSale = 0;
  let units = 0;
  const restock = [];
  const withoutCost = [];
  for (const p of products) {
    const list = variants.get(p.id) || [];
    const min = p.min_stock ?? DEFAULT_MIN_STOCK;
    const items = list.length
      ? list.map((x) => ({ stock: x.stock, price: variantPrice(p, x), label: `${p.name} · ${x.name}` }))
      : [{ stock: p.stock, price: effectivePrice(p), label: p.name }];
    for (const it of items) {
      units += it.stock;
      stockSale += it.stock * it.price;
      if (p.cost_cents !== null) stockCost += it.stock * p.cost_cents;
      if (it.stock <= min) restock.push({ id: p.id, name: it.label, stock: it.stock, min, supplier: p.supplier });
    }
    if (p.cost_cents === null) withoutCost.push(p.id);
  }
  restock.sort((a, b) => a.stock - b.stock);

  const soldRecently = new Set((await db.prepare(
    `SELECT DISTINCT json_extract(j.value,'$.id') AS id FROM orders o, json_each(o.items_json) j
      WHERE o.store_id=? AND ${SOLD} AND o.created_at >= datetime('now','-${STALE_DAYS} days')`,
  ).bind(storeId).all()).results.map((r) => r.id));
  const staleCutoff = new Date(Date.now() - STALE_DAYS * 86400000).toISOString().slice(0, 19).replace("T", " ");
  const stale = products.filter((p) => p.stock > 0 && !soldRecently.has(p.id) && (!p.created_at || p.created_at < staleCutoff)).map((p) => p.id);

  const pending = (await db.prepare("SELECT COUNT(*) AS n FROM orders WHERE store_id=? AND status='pending'").bind(storeId).first()).n;
  const receivable = (await db.prepare(
    "SELECT COALESCE(SUM(receivable_cents),0) AS cents, COUNT(*) AS n FROM orders WHERE store_id=? AND status='completed' AND receivable_cents>0",
  ).bind(storeId).first());
  const carts = (await db.prepare(
    "SELECT COUNT(*) AS n FROM abandoned_carts WHERE store_id=? AND status='open' AND updated_at <= datetime('now','-30 minutes')",
  ).bind(storeId).first()).n;

  // Recomendações acionáveis, só com fatos verificáveis.
  const tips = [];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  if (pending) tips.push({ kind: "pending", text: `${plural(pending, "pedido aguarda", "pedidos aguardam")} sua confirmação.`, action: { view: "pedidos", status: "pending" } });
  const out = restock.filter((r) => r.stock === 0).length;
  if (restock.length) tips.push({ kind: "restock", text: out ? `${plural(restock.length, "item está", "itens estão")} acabando ou esgotados (${out} sem estoque).` : `${plural(restock.length, "item está", "itens estão")} perto de acabar.`, action: { view: "produtos", ids: [...new Set(restock.map((r) => r.id))], label: "Preciso repor" } });
  if (top[0] && top[0].share >= 25 && current.sales >= 3) tips.push({ kind: "top", text: `${top[0].name}${top[0].variant ? ` (${top[0].variant})` : ""} representa ${top[0].share}% das suas vendas no período.`, action: { view: "produtos", ids: [top[0].id], label: "Mais vendido" } });
  if (stale.length && soldRecently.size) tips.push({ kind: "stale", text: `${plural(stale.length, "produto com estoque não teve", "produtos com estoque não tiveram")} vendas nos últimos ${STALE_DAYS} dias.`, action: { view: "produtos", ids: stale, label: `Sem vendas em ${STALE_DAYS} dias` } });
  if (withoutCost.length) tips.push({ kind: "cost", text: `Informe o preço de custo de ${plural(withoutCost.length, "produto", "produtos")} para ver o lucro real.`, action: { view: "produtos", ids: withoutCost, label: "Sem preço de custo" } });
  if (carts) tips.push({ kind: "carts", text: `${plural(carts, "cliente deixou", "clientes deixaram")} o carrinho sem finalizar e autorizou contato.`, action: { view: "pedidos", status: "abandoned" } });

  return json({
    period, start, end, previous_start: prevStart, previous_end: prevEnd,
    current, previous,
    pending_orders: pending,
    receivable: { cents: receivable.cents, sales: receivable.n },
    top_products: top,
    stock: {
      units, cost_value: stockCost, sale_value: stockSale,
      potential_profit: withoutCost.length < products.length ? stockSale - stockCost : null,
      products_without_cost: withoutCost.length, restock_count: restock.length,
      restock: restock.slice(0, 8),
    },
    recommendations: tips,
  });
}
