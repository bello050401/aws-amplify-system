/** Official goods/upload success means queued, never applied or published. */
export function parseNextEngineUploadReceipt(value: unknown): {
  queueId: string;
  state: "QUEUED";
  publicationConfirmed: false;
} {
  if (!value || typeof value !== "object") throw new Error("商品登録受付の応答が不正です。");
  const payload = value as Record<string, unknown>;
  if (payload.result !== "success" || typeof payload.que_id !== "string" || !/^[1-9][0-9]*$/.test(payload.que_id))
    throw new Error("商品登録の受付番号を確認できませんでした。再送信前に登録状況を確認してください。");
  // Deliberately omit authentication fields and untrusted server messages.
  return { queueId: payload.que_id, state: "QUEUED", publicationConfirmed: false };
}
