// PDV: venda presencial registrada pelo lojista.
// Registro de pagamento, não processamento financeiro. A venda usa os mesmos
// gatilhos de estoque dos pedidos: entra como pendente, é confirmada (baixa
// atômica, sem estoque negativo) e concluída na mesma transação.

import { HttpError, json, readJson } from "../lib/http.js";
import { audit, rateLimit } from "../lib/session.js";
import * as v from "../lib/validate.js";
import { priceItems } from "./public.js";

export const PAYMENT_METHODS = {
  pix: "Pix",
  cash: "Dinheiro",
  credit: "Cartão de crédito",
  debit: "Cartão de débito",
  account: "A prazo",
};

function saleId(value) {
  const text = String(value ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text)) throw new HttpError(400, "Identificador da venda inválido");
  return text;
}

function paymentsInput(list, total) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 4) throw new HttpError(400, "Informe a forma de pagamento");
  const merged = new Map();
  for (const p of list) {
    if (!PAYMENT_METHODS[p?.method]) throw new HttpError(400, "Forma de pagamento inválida");
    const amount = v.cents(p.amount_cents, "valor do pagamento");
    merged.set(p.method, (merged.get(p.method) || 0) + amount);
  }
  const payments = [...merged].filter(([, amount]) => amount > 0).map(([method, amount_cents]) => ({ method, amount_cents }));
  const sum = payments.reduce((s, p) => s + p.amount_cents, 0);
  if (total > 0 && !payments.length) throw new HttpError(400, "Informe a forma de pagamento");
  if (sum !== total) throw new HttpError(400, `A soma dos pagamentos (${(sum / 100).toFixed(2).replace(".", ",")}) deve ser igual ao total da venda (${(total / 100).toFixed(2).replace(".", ",")})`);
  return { payments, receivable: payments.find((p) => p.method === "account")?.amount_cents || 0 };
}

export function saleView(row) {
  const items = JSON.parse(row.items_json).map(({ cost_cents: _c, ...i }) => i);
  return {
    id: row.id, code: row.id.slice(0, 8).toUpperCase(), channel: row.channel, status: row.status, created_at: row.created_at,
    items, subtotal_cents: row.subtotal_cents, discount_cents: row.discount_cents, total_cents: row.total_cents,
    payments: JSON.parse(row.payments_json || "[]"), receivable_cents: row.receivable_cents,
    customer_name: row.customer_name, customer_phone: row.customer_phone, notes: row.notes,
  };
}

const SALE_COLUMNS = "id,store_id,channel,status,created_at,items_json,subtotal_cents,discount_cents,total_cents,payments_json,receivable_cents,customer_name,customer_phone,notes";

// POST /api/sales — idempotente pelo id gerado no aparelho (reenvio não duplica).
export async function createSale(request, env, session) {
  const db = env.DB;
  const storeId = session.store.id;
  await rateLimit(db, "sale", session.user.id, 300);
  const body = await readJson(request);
  const id = saleId(body.id);
  const replay = async () => {
    const row = await db.prepare(`SELECT ${SALE_COLUMNS} FROM orders WHERE id=?`).bind(id).first();
    if (!row) return null;
    if (row.store_id !== storeId || row.channel !== "pos") throw new HttpError(409, "Identificador da venda já usado");
    return json({ ...saleView(row), replayed: true });
  };
  const previous = await replay();
  if (previous) return previous;

  const { items, subtotal } = await priceItems(db, { id: storeId }, body.items, { includeHidden: true, maxItems: 100 });
  const discount = body.discount_cents === undefined || body.discount_cents === null ? 0 : v.cents(body.discount_cents, "desconto");
  if (discount > subtotal) throw new HttpError(400, "O desconto não pode ser maior que o valor dos produtos");
  const total = subtotal - discount;
  const { payments, receivable } = paymentsInput(body.payments, total);
  const phone = v.phone(body.customer_phone, { optional: true });
  let name = v.cleanText(body.customer_name, 100);
  if (receivable && (!name || !phone)) throw new HttpError(400, "Para vender a prazo, informe o nome e o telefone do cliente");
  if (!name) name = phone ? "Cliente" : "Cliente do balcão";
  const notes = v.cleanText(body.notes, 500, { multiline: true });

  try {
    await db.batch([
      db.prepare(
        `INSERT INTO orders(id,store_id,items_json,total_cents,subtotal_cents,discount_cents,coupon_code,customer_name,customer_phone,notes,
                            channel,payments_json,receivable_cents,created_by,status)
         VALUES(?,?,?,?,?,?,'',?,?,?,'pos',?,?,?,'pending')`,
      ).bind(id, storeId, JSON.stringify(items), total, subtotal, discount, name, phone, notes, JSON.stringify(payments), receivable, session.user.id),
      db.prepare("UPDATE orders SET status='confirmed' WHERE id=? AND store_id=?").bind(id, storeId),
      db.prepare("UPDATE orders SET status='completed' WHERE id=? AND store_id=?").bind(id, storeId),
    ]);
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("Estoque")) throw new HttpError(409, "Estoque insuficiente para um dos itens. Confira as quantidades.");
    // Dois envios simultâneos do mesmo id: devolve a venda já registrada.
    if (message.includes("UNIQUE") || message.includes("PRIMARY")) {
      const again = await replay();
      if (again) return again;
    }
    throw error;
  }
  await audit(db, { storeId, userId: session.user.id, action: "sale.created", target: id, detail: `${(total / 100).toFixed(2)} · ${payments.map((p) => p.method).join("+")}` });
  const row = await db.prepare(`SELECT ${SALE_COLUMNS} FROM orders WHERE id=?`).bind(id).first();
  return json(saleView(row), 201);
}
