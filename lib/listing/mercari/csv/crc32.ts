/**
 * ZIP(imageZip.ts)のCRC-32計算。外部依存なし(archiver/jszip等は
 * package.jsonに存在せず、この worktree では npm install が使えないため
 * 新規依存を追加しない方針——標準のCRC-32多項式(IEEE 802.3、ZIP仕様が
 * 要求するもの)をテーブル方式で自前実装する)。
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
