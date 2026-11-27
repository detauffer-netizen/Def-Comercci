// Utilitários HTTP compartilhados pelas rotas da API.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

// Lê um corpo JSON com limite de tamanho. Exigir application/json também
// impede que formulários de outros sites enviem requisições "simples" (CSRF).
export async function readJson(request, maxBytes = 64 * 1024) {
  const type = request.headers.get("Content-Type") || "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Envie os dados no formato JSON");
  }
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "Conteúdo muito grande");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "JSON inválido");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "JSON inválido");
  }
  return value;
}

export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}
