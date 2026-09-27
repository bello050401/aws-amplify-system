/** Goods-master queue completion is separate from Mercari publication. */
export function parseGoodsUploadQueue(value: unknown, queueId: string) {
  const invalid = () => new Error("商品登録の処理状況を確認できませんでした。");
  if (!/^[1-9][0-9]*$/.test(queueId) || !value || typeof value !== "object") throw invalid();
  const payload = value as Record<string, unknown>;
  if (payload.result !== "success" || !Array.isArray(payload.data) || payload.data.length !== 1) throw invalid();
  const row = payload.data[0];
  if (!row || typeof row !== "object" || String(row.que_id) !== queueId || row.que_method_name !== "SYOHIN_KIHON_CSV") throw invalid();
  const states = { "0": "WAITING", "1": "PROCESSING", "2": "MASTER_APPLIED", "-1": "FAILED" } as const;
  if (typeof row.que_status_id !== "string" && typeof row.que_status_id !== "number") throw invalid();
  const status = String(row.que_status_id);
  if (!Object.prototype.hasOwnProperty.call(states, status)) throw invalid();
  return { queueId, state: states[status as keyof typeof states], publicationConfirmed: false as const };
}
