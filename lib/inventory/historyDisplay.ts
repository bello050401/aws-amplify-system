import type { InventoryHistoryRow } from "./queries";

/**
 * 更新履歴テーブルの表示ヘルパー(P1 詳細遷移の待ち時間短縮 補正、
 * 2026-09-12)。
 *
 * 元々は InventoryHistoryTable.tsx(Server Component、初回SSR描画)一箇所
 * にしかなかったが、履歴取得の失敗を局所化する今回の修正で、同じ表を
 * クライアント側の再試行後にも描画する必要が出た
 * (InventoryHistorySection.tsx)——初回SSRと再試行後の2箇所が、同じ
 * テーブルを1文字も違わず描く必要があるので、ここだけは
 * 「1箇所の共有ヘルパーへ寄せる」側を選ぶ(このファイル自体の先頭コメ
 * ントで触れている「呼び出し元同士を結合させない」という repo 全体の
 * 既定方針そのものは変えていない——EditInventoryForm.tsx/
 * KnowledgeSettingsPanel.tsxのformatDateTimeのような無関係な機能同士を
 * 結合するのは避けつつ、同一機能・同一表を描く2つの入口だけを結ぶ)。
 *
 * `InventoryHistoryRow` は type-only import なので、tsx/esbuild的な
 * 型消去のもとではこのファイルの実行時import文には現れない——
 * queries.ts(server-only・Amplifyクライアントを持つ)を実際に読み込む
 * ことなく、このファイル単体を node/tsx で直接実行できる
 * (scripts/verify-inventory-history-resilience.ts 参照)。
 */

/** ISO datetime → "2026/08/28 17:40" — exact zero-padded format; Intl's dateStyle/timeStyle shorthand drops the leading zero on month/day/hour, which doesn't match. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The history log (lib/inventory/history.ts) writes one row per changed
 * field, `fieldName` doing double duty as either an actual field label
 * ("商品名") or, for create/delete, the operation itself ("登録"/"削除")
 * — there's no separate stored "operation type" column. spec F wants a
 * ZAICO-style 日時/操作/変更内容/実行者 table, so these two helpers
 * derive that split from what's already stored rather than needing a
 * schema change.
 */
export function historyOperationLabel(fieldName: string): string {
  if (fieldName === "登録" || fieldName === "削除") return fieldName;
  return "編集";
}

export function historyChangeSummary(h: Pick<InventoryHistoryRow, "fieldName" | "oldValue" | "newValue">): string {
  if (h.fieldName === "登録" || h.fieldName === "削除") return h.newValue ?? h.oldValue ?? "-";
  return `${h.fieldName} ${h.oldValue ?? "-"} → ${h.newValue ?? "-"}`;
}
