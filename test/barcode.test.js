import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PATTERNS, code128Widths } from "../public/js/barcode.js";

// Decodificador independente: lê os padrões de 11 módulos e confere o dígito verificador.
function decode(widths) {
  const symbols = [];
  let i = 0;
  while (i < widths.length) {
    const size = widths.length - i === 7 ? 7 : 6;
    symbols.push(PATTERNS.indexOf(widths.slice(i, i + size).join("")));
    i += size;
  }
  assert.ok(symbols.every((s) => s >= 0), "padrão desconhecido");
  assert.equal(symbols[0], 104, "início B");
  assert.equal(symbols.at(-1), 106, "parada");
  const data = symbols.slice(1, -2);
  const check = [104, ...data].reduce((sum, c, k) => sum + c * (k || 1), 0) % 103;
  assert.equal(symbols.at(-2), check, "dígito verificador");
  return data.map((c) => String.fromCharCode(c + 32)).join("");
}

describe("código de barras Code 128", () => {
  test("tabela padrão: 107 símbolos distintos, 3 barras e 3 espaços somando 11 módulos", () => {
    assert.equal(PATTERNS.length, 107);
    assert.equal(new Set(PATTERNS).size, 107);
    for (const p of PATTERNS.slice(0, 106)) {
      assert.equal(p.length, 6);
      assert.equal([...p].reduce((a, b) => a + Number(b), 0), 11);
    }
    assert.equal([...PATTERNS[106]].reduce((a, b) => a + Number(b), 0), 13);
  });

  test("codifica e decodifica SKU e EAN com dígito verificador correto", () => {
    for (const text of ["GAR-500", "7891234567895", "VES-01", "a b/C.9"]) assert.equal(decode(code128Widths(text)), text);
    // Conta feita à mão: 104 + 48·1 + 42·2 + 42·3 + 17·4 + 18·5 + 19·6 + 35·7 = 879; 879 mod 103 = 55.
    const w = code128Widths("PJJ123C");
    assert.equal(PATTERNS.indexOf(w.slice(-13, -7).join("")), 55);
  });

  test("recusa texto vazio, longo ou com acentos", () => {
    for (const bad of ["", "x".repeat(41), "Pão"]) assert.throws(() => code128Widths(bad));
  });
});
