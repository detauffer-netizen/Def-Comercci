// Verificações estáticas do frontend: sintaxe de todos os scripts e ausência
// de scripts ou handlers inline (exigência da Content-Security-Policy).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = new URL("../public/", import.meta.url).pathname;
let failures = 0;

for (const file of readdirSync(join(root, "js"))) {
  try {
    execFileSync(process.execPath, ["--check", join(root, "js", file)], { stdio: "pipe" });
    console.log(`ok - sintaxe js/${file}`);
  } catch (error) {
    failures++;
    console.error(`FALHA - js/${file}\n${error.stderr}`);
  }
}

for (const file of readdirSync(root).filter((f) => f.endsWith(".html"))) {
  const html = readFileSync(join(root, file), "utf8");
  const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>/i.test(html);
  const inlineHandler = /\son[a-z]+\s*=\s*["']/i.test(html);
  const javascriptUrl = /href\s*=\s*["']javascript:/i.test(html);
  if (inlineScript || inlineHandler || javascriptUrl) {
    failures++;
    console.error(`FALHA - ${file}: script inline, handler inline ou javascript: (bloqueados pela CSP)`);
  } else {
    console.log(`ok - ${file} compatível com a CSP`);
  }
}

if (failures) process.exit(1);
