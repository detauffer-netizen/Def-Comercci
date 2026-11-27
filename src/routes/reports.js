// Relatórios por período. "Vendas" = pedidos confirmados ou concluídos.
// Datas agrupadas no horário de Brasília (UTC-3, sem horário de verão).

import { HttpError, json } from "../lib/http.js";

const PERIODS = new Set([7, 30, 90]);
const SOLD = "status IN ('confirmed','completed')";
const LOCAL_DAY = "date(created_at, '-3 hours')";

function localToday() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function addDays(isoDay, n) {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function report(request, env, session) {
  const days = Number(new URL(request.url).searchParams.get("days") || 30);
  if (!PERIODS.has(days)) throw new HttpError(400, "Período inválido: use 7, 30 ou 90 dias");
  const db = env.DB;
  const store = session.store.id;
  const end = localToday();
  const start = addDays(end, -(days - 1));
  const prevStart = addDays(start, -days);

  const rows = (await db.prepare(
    `SELECT ${LOCAL_DAY} AS day, COUNT(*) AS orders,
            COALESCE(SUM(CASE WHEN ${SOLD} THEN total_cents END),0) AS revenue,
            COALESCE(SUM(${SOLD}),0) AS sold
       FROM orders WHERE store_id=? AND ${LOCAL_DAY} BETWEEN ? AND ? GROUP BY day`,
  ).bind(store, start, end).all()).results;
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const series = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(start, i);
    const r = byDay.get(day);
    series.push({ day, orders: r?.orders || 0, sold: r?.sold || 0, revenue: r?.revenue || 0 });
  }

  const totals = (period) => db.prepare(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(${SOLD}),0) AS sold,
            COALESCE(SUM(CASE WHEN ${SOLD} THEN total_cents END),0) AS revenue,
            COALESCE(SUM(status='cancelled'),0) AS cancelled,
            COALESCE(SUM(status='pending'),0) AS pending
       FROM orders WHERE store_id=? AND ${LOCAL_DAY} BETWEEN ? AND ?`,
  ).bind(store, ...period).first();
  const current = await totals([start, end]);
  const previous = await totals([prevStart, addDays(start, -1)]);

  const top = (await db.prepare(
    `SELECT json_extract(j.value,'$.name') AS name, json_extract(j.value,'$.variant_name') AS variant,
            SUM(json_extract(j.value,'$.quantity')) AS quantity,
            SUM(json_extract(j.value,'$.quantity') * json_extract(j.value,'$.price_cents')) AS revenue
       FROM orders o, json_each(o.items_json) j
      WHERE o.store_id=? AND ${SOLD.replace("status", "o.status")} AND date(o.created_at,'-3 hours') BETWEEN ? AND ?
      GROUP BY json_extract(j.value,'$.id'), json_extract(j.value,'$.variant_id')
      ORDER BY revenue DESC, quantity DESC LIMIT 8`,
  ).bind(store, start, end).all()).results;

  return json({
    days,
    start,
    end,
    series,
    totals: { ...current, average_ticket: current.sold ? Math.round(current.revenue / current.sold) : 0 },
    previous: { revenue: previous.revenue, sold: previous.sold },
    top_products: top,
  });
}
