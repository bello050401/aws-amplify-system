import sharp from "sharp";

/**
 * テスト用の合成JPEGを作る。orientation=6(90°回転が必要)とGPS/Copyrightを
 * 埋め込み、「画像方向の正規化」と「GPS・個人情報の削除」を検証できる
 * ようにする。実際の商品写真は使わない。
 */
export async function makeSyntheticSourceJpeg({ width = 400, height = 200, color = { r: 200, g: 80, b: 40 }, orientation = 6 } = {}) {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    raw[i * 3] = color.r;
    raw[i * 3 + 1] = color.g;
    raw[i * 3 + 2] = color.b;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .withMetadata({ orientation })
    .withExifMerge({ IFD0: { Copyright: "Test Photographer" }, GPS: { GPSLatitudeRef: "N", GPSLatitude: "35/1 40/1 0/1" } })
    .jpeg()
    .toBuffer();
}
