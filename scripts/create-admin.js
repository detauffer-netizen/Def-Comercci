// Gera o SQL que cria (ou promove) um super administrador da plataforma.
// O administrador não pertence a nenhuma loja.
//
//   node scripts/create-admin.js admin@exemplo.com > /tmp/admin.sql
//   (digite a senha quando solicitado; ela não aparece na tela nem no histórico)
//   npx wrangler d1 execute def-commerce-db --remote --file=/tmp/admin.sql
//   rm /tmp/admin.sql
//
// Se o e-mail já existir, a conta é promovida e a senha NÃO é alterada.

import { createInterface } from "node:readline";
import { hashPassword } from "../src/lib/crypto.js";

const email = String(process.argv[2] || "").trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("Uso: node scripts/create-admin.js <email>");
  process.exit(1);
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl._writeToOutput = (text) => { if (text.includes(question)) process.stderr.write(text); };
    rl.question(question, (answer) => { rl.close(); process.stderr.write("\n"); resolve(answer); });
  });
}

const password = await askHidden("Senha do administrador (mínimo 12 caracteres): ");
if (password.length < 12 || password.length > 128) {
  console.error("A senha deve ter de 12 a 128 caracteres.");
  process.exit(1);
}
const id = crypto.randomUUID();
const hash = await hashPassword(password);
const q = (s) => `'${s.replaceAll("'", "''")}'`;
console.log(`INSERT OR IGNORE INTO users(id,email,password_hash,name) VALUES(${q(id)},${q(email)},${q(hash)},'Administrador');`);
console.log(`INSERT OR IGNORE INTO platform_admins(user_id) SELECT id FROM users WHERE email=${q(email)};`);
