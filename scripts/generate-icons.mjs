// BELLO独自アプリアイコン生成スクリプト(依存パッケージなし・純Node実装)。
// ZAICO等のロゴ/アイコン資産は一切使用しない。BELLOブランドカラー(ネイビー)の
// 角丸スクエア背景に、モノグラム"B"を配置したシンプルな独自アイコン。
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// 5x7ドットのビットマップフォントで "B" を描く(シンプルな独自モノグラム)
// prettier-ignore
const GLYPH_B = [
  "1111 ",
  "1  1 ",
  "1  1 ",
  "1111 ",
  "1  1 ",
  "1  1 ",
  "1111 ",
];

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function buildPng(size, { bg = "#1f2c4d", fg = "#ffffff", accent = "#d15f2e", radiusRatio = 0.22 }) {
  const [br, bgc, bb] = hexToRgb(bg);
  const [fr, fg2, fb] = hexToRgb(fg);
  const [ar, ag, ab] = hexToRgb(accent);
  const radius = size * radiusRatio;

  const rowBytes = size * 4 + 1; // filter byte + RGBA
  const raw = Buffer.alloc(rowBytes * size);

  const glyphRows = GLYPH_B.length;
  const glyphCols = GLYPH_B[0].length;
  const cell = Math.floor((size * 0.5) / glyphRows);
  const glyphW = cell * glyphCols;
  const glyphH = cell * glyphRows;
  const offsetX = Math.floor((size - glyphW) / 2);
  const offsetY = Math.floor((size - glyphH) / 2);

  const isInsideRoundedSquare = (x, y) => {
    const cx = x < radius ? radius : x > size - radius ? size - radius : x;
    const cy = y < radius ? radius : y > size - radius ? size - radius : y;
    if (x >= radius && x <= size - radius) return true;
    if (y >= radius && y <= size - radius) return true;
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  for (let y = 0; y < size; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // no filter
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 4;
      let r = 0, g = 0, b = 0, a = 0;

      if (isInsideRoundedSquare(x, y)) {
        r = br; g = bgc; b = bb; a = 255;

        // アクセントの下部バー(独自デザイン要素)
        if (y > size * 0.82 && y < size * 0.86) {
          r = ar; g = ag; b = ab;
        }

        // モノグラム"B"
        const gx = x - offsetX;
        const gy = y - offsetY;
        if (gx >= 0 && gy >= 0 && gx < glyphW && gy < glyphH) {
          const col = Math.floor(gx / cell);
          const row = Math.floor(gy / cell);
          if (GLYPH_B[row] && GLYPH_B[row][col] === "1") {
            r = fr; g = fg2; b = fb;
          }
        }
      }

      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(new URL("../public/icons", import.meta.url), { recursive: true });

const targets = [
  { size: 32, file: "icon-32.png" },
  { size: 180, file: "apple-touch-icon.png" },
  { size: 192, file: "icon-192.png" },
  { size: 512, file: "icon-512.png" },
];

for (const t of targets) {
  const png = buildPng(t.size, {});
  writeFileSync(new URL(`../public/icons/${t.file}`, import.meta.url), png);
  console.log(`generated public/icons/${t.file} (${png.length} bytes)`);
}

// maskable icon (安全マージンを大きめに取ったもの)
const maskable = buildPng(512, { radiusRatio: 0.0 });
writeFileSync(new URL("../public/icons/icon-512-maskable.png", import.meta.url), maskable);
console.log("generated public/icons/icon-512-maskable.png");
