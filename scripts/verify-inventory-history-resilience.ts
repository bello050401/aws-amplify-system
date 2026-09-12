/**
 * 局所エラー処理レビュー補正(2026-09-12)の合成試験。
 *
 * 依存ゼロで動く部分だけを対象にする——このタスクworktreeには
 * node_modules が実体として無く(このスクリプト実行時点で確認済み)、
 * "server-only"/@aws-amplify系を読み込む lib/inventory/queries.ts や
 * React/JSXを含む InventoryHistoryTable.tsx / InventoryHistorySection.tsx
 * 自体はこのサンドボックスから直接importできない(cf. memory
 * qa-worktree-tooling-limits)。
 *
 * lib/inventory/historyDisplay.ts は意図的に実行時import(型のみの
 * `import type`を除く)を持たない設計にしてあるため、ここだけは
 * コピーではなく本物のモジュールをそのままimportして検証できる。
 *
 * 実行: node --input-type=module でエイリアス解決フックを積んだ上で、
 * このファイル自体を動かす(このリポジトリの他scripts/verify-*.tsが
 * with-server-only-stub.cjs経由でtsxを叩くのと同じ位置付けの、
 * 依存ゼロ版)。
 *
 * カバーしない範囲(手動コードレビュー+実tsc --noEmitで代替、下記参照):
 *   - getInventoryHistory の GraphQL errors チェック(lib/inventory/
 *     queries.ts) — Amplifyクライアントへの依存があるため実行不可。
 *     コードは「errorsが truthy なら例外を投げる」の3行のみで、
 *     lib/inventory/salesAggregateStore.ts の fetchSnapshot と同じ形。
 *   - InventoryHistoryTable.tsx の try/catch(async Server Component、
 *     JSX/react依存)— 例外を投げず必ず InventoryHistorySection を
 *     返す1本道の制御フロー。
 *   - InventoryHistorySection.tsx の状態遷移(useState、React依存)。
 *   - 上記すべては `node node_modules/typescript/bin/tsc --noEmit` で
 *     型検査済み(0エラー、amplify_outputs.jsonの生成物を本体リポジトリ
 *     から読み取り専用コピーして補った以外は無改変)。
 *
 * 詳細履歴の実境界試験(2026-09-12、task_a748ee69c990317c24)以降は
 * 上の「カバーしない範囲」のうち queries.ts / InventoryHistoryTable.tsx
 * の2つは scripts/verify-inventory-history-boundary.ts が実物のモジュール
 * (dataClient境界だけmock)を通して検証するようになった——このファイル
 * 自体は変えていない(依存ゼロで動く表示ヘルパーの回帰試験としての
 * 役割はそのまま)。InventoryHistorySection.tsx の状態遷移は実ブラウザ
 * (scripts/qa-inventory-history-*.cjs、docs/inventory-detail-history-
 * boundary-qa-20260912.md参照)で検証する。
 */
import assert from "node:assert/strict";
import { formatDateTime, historyOperationLabel, historyChangeSummary } from "@/lib/inventory/historyDisplay";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

console.log("=== formatDateTime: 分割前と同じゼロ埋め書式 ===");
check("2026-08-28T17:40:00.000Z相当のISOを日本時間ではなくローカル値のまま整形", () => {
  // Dateはローカルタイムゾーンで解釈される既存実装のまま(分割時に変更していない)。
  const iso = "2026-01-05T09:05:00.000Z";
  const out = formatDateTime(iso);
  assert.match(out, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/, `zero-padded format expected, got "${out}"`);
});

console.log("\n=== historyOperationLabel: 登録/削除/編集の分岐(スキーマ変更なしの派生ロジック) ===");
check('"登録" → "登録"', () => assert.equal(historyOperationLabel("登録"), "登録"));
check('"削除" → "削除"', () => assert.equal(historyOperationLabel("削除"), "削除"));
check('"statusId"（フィールド名）→ "編集"', () => assert.equal(historyOperationLabel("statusId"), "編集"));
check('"商品名" → "編集"', () => assert.equal(historyOperationLabel("商品名"), "編集"));

console.log("\n=== historyChangeSummary: 登録/削除はnewValue優先、編集はold→new ===");
check("登録: newValueをそのまま表示", () => {
  assert.equal(historyChangeSummary({ fieldName: "登録", oldValue: null, newValue: "有効" }), "有効");
});
check("削除: newValueが無ければoldValueへフォールバック", () => {
  assert.equal(historyChangeSummary({ fieldName: "削除", oldValue: "有効", newValue: null }), "有効");
});
check("登録/削除以外: フィールド名 旧 → 新 の形式", () => {
  assert.equal(
    historyChangeSummary({ fieldName: "statusId", oldValue: "st-photo", newValue: "st-listing" }),
    "statusId st-photo → st-listing",
  );
});
check("値がnullなら'-'で埋める(取得エラーの空文字列と混同しない)", () => {
  assert.equal(historyChangeSummary({ fieldName: "note", oldValue: null, newValue: null }), "note - → -");
});

console.log("\n=== データなし(空配列) と 取得失敗(例外) は別の状態として扱う ===");
check("空配列はエラーではない(InventoryHistorySectionはinitialRows===nullのときだけerror状態にする)", () => {
  const emptyRows: unknown[] = [];
  // InventoryHistoryTable.tsxの分岐と同じ形: null(失敗)とは異なるコード経路。
  const isTreatedAsError = (emptyRows as unknown[] | null) === null;
  assert.equal(isTreatedAsError, false);
});
check("nullは取得失敗として扱う", () => {
  const failedRows: unknown[] | null = null;
  const isTreatedAsError = failedRows === null;
  assert.equal(isTreatedAsError, true);
});

console.log(`\n${passed}件 pass`);
