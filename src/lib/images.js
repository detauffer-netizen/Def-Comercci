// Armazenamento de imagens no Cloudflare R2 (binding IMAGES).
// O navegador comprime e redimensiona antes do envio; aqui validamos o tipo
// real pelos bytes iniciais, o tamanho e isolamos as chaves por loja.

import { HttpError } from "./http.js";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGES_PER_PRODUCT = 8;

const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export function requireBucket(env) {
  if (!env.IMAGES) {
    throw new HttpError(503, "Armazenamento de imagens ainda não configurado nesta instalação");
  }
  return env.IMAGES;
}

export function sniffImageType(bytes) {
  const b = new Uint8Array(bytes.slice(0, 12));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  const ascii = String.fromCharCode(...b);
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}

export async function readImageUpload(request) {
  const declared = Number(request.headers.get("Content-Length") || "0");
  if (declared > MAX_IMAGE_BYTES) throw new HttpError(413, "Imagem muito grande (máximo 2 MB após compressão)");
  const type = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!EXTENSIONS[type]) throw new HttpError(415, "Formato não suportado: use JPEG, PNG ou WebP");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) throw new HttpError(400, "Imagem vazia");
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new HttpError(413, "Imagem muito grande (máximo 2 MB após compressão)");
  const real = sniffImageType(bytes);
  if (!real) throw new HttpError(415, "O arquivo enviado não é uma imagem válida");
  return { bytes, contentType: real, extension: EXTENSIONS[real] };
}

// Toda chave começa com stores/<store_id>/, então uma loja nunca grava ou
// apaga arquivos de outra.
export function imageKey(storeId, kind, extension) {
  return `stores/${storeId}/${kind}/${crypto.randomUUID()}.${extension}`;
}

export function imageUrl(key) {
  return key ? `/img/${key}` : "";
}

export async function putImage(env, key, upload) {
  await requireBucket(env).put(key, upload.bytes, {
    httpMetadata: { contentType: upload.contentType, cacheControl: "public, max-age=31536000, immutable" },
  });
}

export async function deleteImages(env, keys) {
  const list = keys.filter(Boolean);
  if (!list.length || !env.IMAGES) return;
  await env.IMAGES.delete(list);
}

const KEY_PATTERN = /^stores\/[0-9a-f-]{36}\/(?:products\/[0-9a-f-]{36}|logo|banner)\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/;

export async function serveImage(env, key) {
  if (!KEY_PATTERN.test(key) || !env.IMAGES) return new Response("Not found", { status: 404 });
  const object = await env.IMAGES.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata?.(headers);
  headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}
