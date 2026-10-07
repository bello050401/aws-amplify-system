import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

// The Shops product-registration guide limits one JPEG/PNG product image to 8 MB.
// Decimal MB is deliberately conservative for this local proof file.
export const MAX_SHOPS_IMAGE_BYTES = 8_000_000;
const HASH = /^[a-f0-9]{64}$/;
const SKU = /^[A-Za-z0-9_-]{1,40}$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Validate a file already obtained through BELLO's signed, read-only image-download path. */
export function inspectExistingImage(bytes, { inventoryCode, expectedSha256 }) {
  if (!Buffer.isBuffer(bytes) || !SKU.test(inventoryCode) || !HASH.test(expectedSha256))
    throw Error("Invalid pinned image input");
  if (bytes.length === 0 || bytes.length > MAX_SHOPS_IMAGE_BYTES)
    throw Error("Image size is outside the Shops product-image limit");
  const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  const png = bytes.length >= 20 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) &&
    bytes.subarray(-8).equals(Buffer.from([73, 69, 78, 68, 174, 66, 96, 130]));
  if (!jpeg && !png) throw Error("Only JPEG or PNG image bytes are accepted");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (!timingSafeEqual(Buffer.from(sha256), Buffer.from(expectedSha256)))
    throw Error("Image bytes do not match the selected BELLO image");
  const extension = jpeg ? "jpg" : "png";
  return { inventoryCode, sha256, byteLength: bytes.length,
    mimeType: jpeg ? "image/jpeg" : "image/png",
    filename: `${inventoryCode}-${sha256.slice(0, 16)}.${extension}` };
}

/** Prepare one pinned local file for a later, separately authorized Shops file-input step.
 * No network call, Shops browser action, upload, product save or retry occurs here.
 */
export async function prepareExistingImageFile({ sourcePath, outputDirectory, inventoryCode, expectedSha256 }) {
  if (!isAbsolute(sourcePath) || !isAbsolute(outputDirectory)) throw Error("Absolute local paths required");
  const source = await stat(sourcePath);
  if (!source.isFile() || source.size === 0 || source.size > MAX_SHOPS_IMAGE_BYTES)
    throw Error("Image size is outside the Shops product-image limit");
  const bytes = await readFile(sourcePath);
  const image = inspectExistingImage(bytes, { inventoryCode, expectedSha256 });
  await mkdir(outputDirectory, { recursive: true });
  const path = join(outputDirectory, image.filename);
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    // Never replace a previously prepared file. A matching file is reusable.
    const previous = await stat(path);
    if (!previous.isFile() || previous.size !== bytes.length)
      throw Error("Existing proof file differs");
    const existing = await readFile(path);
    inspectExistingImage(existing, { inventoryCode, expectedSha256 });
    if (!existing.equals(bytes)) throw Error("Existing proof file differs");
  }
  return { ...image, path };
}
