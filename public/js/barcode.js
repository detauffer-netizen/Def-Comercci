// Código de barras Code 128 (conjunto B) em SVG, sem dependências.
// Lido por qualquer leitor comum; serve para SKU e para códigos EAN já existentes.

export const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];
const START_B = 104;
const STOP = 106;

// Sequência de larguras (barra, espaço, barra...) em módulos.
export function code128Widths(text) {
  const value = String(text);
  if (!value || value.length > 40 || /[^\x20-\x7e]/.test(value)) throw new Error("Código inválido para etiqueta");
  const codes = [START_B, ...[...value].map((ch) => ch.charCodeAt(0) - 32)];
  const checksum = codes.reduce((sum, code, i) => sum + code * (i || 1), 0) % 103;
  return [...codes, checksum, STOP].flatMap((code) => [...PATTERNS[code]].map(Number));
}

export function barcodeSvg(text, { height = 40 } = {}) {
  const ns = "http://www.w3.org/2000/svg";
  const widths = code128Widths(text);
  const quiet = 10;
  const total = widths.reduce((a, b) => a + b, 0) + quiet * 2;
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${total} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "barcode");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Código de barras ${text}`);
  const rect = (x, w, fill) => {
    const r = document.createElementNS(ns, "rect");
    r.setAttribute("x", String(x));
    r.setAttribute("width", String(w));
    r.setAttribute("height", String(height));
    r.setAttribute("fill", fill);
    svg.append(r);
  };
  rect(0, total, "#fff");
  let x = quiet;
  widths.forEach((w, i) => {
    if (i % 2 === 0) rect(x, w, "#000");
    x += w;
  });
  return svg;
}
