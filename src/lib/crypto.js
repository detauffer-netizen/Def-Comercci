// Hash de senhas (PBKDF2-SHA256) e tokens de sessão.

const encoder = new TextEncoder();
// 100.000 é o máximo de iterações PBKDF2 aceito pelo runtime dos Workers.
export const PBKDF2_ITERATIONS = 100000;

export function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256(text) {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

export function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return toHex(data);
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations, hash: "SHA-256" },
    key,
    256,
  );
  return toHex(bits);
}

export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// Formato atual: pbkdf2$<iterações>$<salt>$<hash>
export async function hashPassword(password) {
  const salt = randomToken(16);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${await pbkdf2(password, salt, PBKDF2_ITERATIONS)}`;
}

// Aceita também o formato legado "<salt>:<hash>" (100.000 iterações).
// Sempre executa uma derivação, mesmo sem usuário, para não revelar por tempo
// de resposta se o e-mail existe.
export async function verifyPassword(password, stored) {
  let iterations = PBKDF2_ITERATIONS;
  let salt = "dummy-salt";
  let expected = "";
  if (typeof stored === "string" && stored.startsWith("pbkdf2$")) {
    const parts = stored.split("$");
    iterations = Number(parts[1]);
    salt = parts[2];
    expected = parts[3];
  } else if (typeof stored === "string" && stored.includes(":")) {
    [salt, expected] = stored.split(":");
  }
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) {
    iterations = PBKDF2_ITERATIONS;
    expected = "";
  }
  const actual = await pbkdf2(password, salt, iterations);
  return expected !== "" && timingSafeEqual(actual, expected);
}

export function needsRehash(stored) {
  return !(typeof stored === "string" && stored.startsWith(`pbkdf2$${PBKDF2_ITERATIONS}$`));
}
