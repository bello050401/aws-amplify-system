import "server-only";

import { createHash } from "node:crypto";
import sharp from "sharp";

const CREATE_IMAGE_ASSET_QUERY = `mutation CreateImageAsset($input: CreateAssetInput!) {
  createImageAsset(input: $input) {
    id
    contentType
    __typename
  }
}`;

export type ObservedImageAssetRequest = {
  body: FormData;
  preparedJpegSha256: string;
};

export type PreparedObservedJpeg = {
  originalSha256: string;
  preparedJpegSha256: string;
  preparedJpegBytes: Uint8Array;
};

/**
 * The observed Shops page uses a 1600x1600 cap and canvas JPEG quality 0.8.
 * Sharp is a different encoder, so byte-for-byte parity is not claimed.
 */
export async function prepareObservedJpeg(
  originalBytes: Uint8Array,
  expectedOriginalSha256: string,
): Promise<PreparedObservedJpeg> {
  if (!(originalBytes instanceof Uint8Array) ||
      originalBytes.length < 4 || originalBytes.length > 20 * 1024 * 1024)
    throw new Error("INVALID_SOURCE_IMAGE_NO_SEND");
  const originalSha256 = createHash("sha256")
    .update(originalBytes).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(expectedOriginalSha256) ||
      originalSha256 !== expectedOriginalSha256)
    throw new Error("SOURCE_IMAGE_MISMATCH_NO_SEND");

  const input = sharp(Buffer.from(originalBytes), { limitInputPixels: 16_000_000 });
  const metadata = await input.metadata();
  if (metadata.format !== "jpeg" || !metadata.width || !metadata.height)
    throw new Error("UNOBSERVED_IMAGE_FORMAT_NO_SEND");
  const prepared = await input.rotate().resize({ width: 1600, height: 1600,
    fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 })
    .toBuffer();
  const preparedJpegBytes = new Uint8Array(prepared);
  const preparedJpegSha256 = createHash("sha256")
    .update(preparedJpegBytes).digest("hex");
  return { originalSha256, preparedJpegSha256, preparedJpegBytes };
}

/**
 * Serializes the multipart request observed in the owner's 2026-10-12 HAR.
 * This does not send it or authorize a listing. The caller must separately
 * verify the authenticated shop, durable send reservation and the mapping
 * from BELLO's original image to these prepared JPEG bytes.
 */
export function buildObservedImageAssetRequest(
  preparedJpegBytes: Uint8Array,
  expectedPreparedJpegSha256: string,
): ObservedImageAssetRequest {
  if (!(preparedJpegBytes instanceof Uint8Array) ||
      preparedJpegBytes.length < 4 ||
      preparedJpegBytes.length > 20 * 1024 * 1024 ||
      preparedJpegBytes[0] !== 0xff || preparedJpegBytes[1] !== 0xd8 ||
      preparedJpegBytes[preparedJpegBytes.length - 2] !== 0xff ||
      preparedJpegBytes[preparedJpegBytes.length - 1] !== 0xd9)
    throw new Error("INVALID_JPEG_NO_SEND");

  const preparedJpegSha256 = createHash("sha256")
    .update(preparedJpegBytes).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(expectedPreparedJpegSha256) ||
      preparedJpegSha256 !== expectedPreparedJpegSha256)
    throw new Error("IMAGE_BYTES_MISMATCH_NO_SEND");

  const body = new FormData();
  body.append("operations", JSON.stringify({
    operationName: "CreateImageAsset",
    query: CREATE_IMAGE_ASSET_QUERY,
    variables: { input: { file: null, protectionKind: "none", public: true } },
  }));
  body.append("map", JSON.stringify({ "1": ["variables.input.file"] }));
  body.append("1", new Blob([new Uint8Array(preparedJpegBytes)],
    { type: "image/jpeg" }), "blob");
  return { body, preparedJpegSha256 };
}

export function parseObservedImageAssetResponse(
  status: number,
  response: unknown,
): { remoteAssetId: string; contentType: "image/jpeg" } | null {
  if (status !== 200 || !response || typeof response !== "object" ||
      Array.isArray(response)) return null;
  const root = response as Record<string, unknown>;
  if ("errors" in root || !root.data || typeof root.data !== "object" ||
      Array.isArray(root.data)) return null;
  const asset = (root.data as Record<string, unknown>).createImageAsset;
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) return null;
  const value = asset as Record<string, unknown>;
  if (typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) ||
      value.contentType !== "image/jpeg") return null;
  return { remoteAssetId: value.id, contentType: "image/jpeg" };
}
