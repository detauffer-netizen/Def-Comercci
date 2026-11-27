import { test, describe } from "node:test";
import assert from "node:assert/strict";
import jsQR from "jsqr";
import { qrMatrix } from "../public/js/qrcode.js";

// Renderiza a matriz em pixels e lê com um decodificador independente (jsQR).
function decode(matrix, scale = 4, margin = 4) {
  const size = (matrix.length + margin * 2) * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  matrix.forEach((row, y) => row.forEach((dark, x) => {
    if (!dark) return;
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const i = (((y + margin) * scale + dy) * size + (x + margin) * scale + dx) * 4;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
      }
    }
  }));
  return jsQR(pixels, size, size)?.data ?? null;
}

describe("QR Code", () => {
  test("links curtos e longos são lidos por um decodificador independente", () => {
    const samples = [
      "https://def-commerce.detauffer.workers.dev/loja/moda-da-ana",
      "https://def-commerce.detauffer.workers.dev/loja/moda-da-ana/p/3f2b5c1a-8d7e-4f6a-9b0c-1d2e3f4a5b6c",
      "https://def-commerce.detauffer.workers.dev/loja/moda-da-ana?categoria=Vestidos%20de%20festa&utm_campaign=balcao-natal",
      "Olá! Promoção de Natal — Pão de mel R$ 9,90",
      "A",
    ];
    for (const text of samples) assert.equal(decode(qrMatrix(text)), text, text);
  });

  test("escolhe a versão pelo tamanho e recusa texto grande demais", () => {
    assert.equal(qrMatrix("A").length, 21); // versão 1
    assert.ok(qrMatrix("x".repeat(200)).length > 40);
    assert.equal(decode(qrMatrix("x".repeat(300))), "x".repeat(300)); // versão com informação de versão (≥ 7)
    assert.throws(() => qrMatrix("x".repeat(2000)));
  });
});
