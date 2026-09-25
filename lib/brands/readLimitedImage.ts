/** Bound downloaded image bytes before buffering an entire remote response. */
export async function readLimitedImage(response: Response, maxBytes: number): Promise<Buffer> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new Error("画像が大きすぎます。");
  if (!response.body) throw new Error("画像を取得できませんでした。");
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("画像が大きすぎます。");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total);
}
