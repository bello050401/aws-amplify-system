import sharp from 'sharp';

/** Keep the BELLO original untouched. Convert WebP/oversized procurement
 * originals in memory to a format and size accepted by ZAICO. */
export async function encodeZaicoPhoto(bytes: Buffer): Promise<string> {
  const jpeg = bytes[0] === 255 && bytes[1] === 216;
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  if (!jpeg && !png && !webp) throw Error('ZAICOへ送信する仕入写真の形式を確認できません。');
  if (bytes.length <= 5 * 1024 * 1024 && (jpeg || png)) {
    return `data:image/${jpeg ? 'jpeg' : 'png'};base64,${bytes.toString('base64')}`;
  }
  for (const width of [2400, 1600, 1200]) {
    const converted = await sharp(bytes, { limitInputPixels: 100_000_000 }).rotate()
      .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
    if (converted.length <= 5 * 1024 * 1024) return `data:image/jpeg;base64,${converted.toString('base64')}`;
  }
  throw Error('ZAICOの写真容量以内に変換できません。BELLOの原本は保持しています。');
}
