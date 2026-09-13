/**
 * EC一覧P1 レビュー補正(2026-09-13)の合成試験——依存ゼロで動く
 * lib/listing/listingsOverviewTableLogic.ts(React/hooks非依存)を、
 * scripts/verify-inventory-history-resilience.tsと同じ位置付けで実際に
 * importして検証する。
 *
 * カバーしない範囲(手動コードレビュー+実tsc --noEmit/実Playwright QAで代替):
 *   - ListingsOverviewTable.tsx自体(Client Component、useState/useEffect
 *     を使う) — フックを呼び出せないNode単体実行環境では検証できない。
 *     ここで検証する`paginate`/`selectableInventoryIds`/
 *     `loadStateFromInitialRows`を実際にどう呼んでいるかは同ファイルの
 *     目視レビューで確認済み(呼び出し箇所はこのファイル1箇所のみ)。
 *     実ブラウザでの364件描画・5秒遅延・read rejectionからの局所復帰は
 *     Playwright QA(scripts/qa-listings-overview-harness.spec.ts)に委ねる
 *     ——このスクリプトは論理(ページ算出・選択対象・状態遷移)の
 *     正しさだけを保証する。
 *   - ListingsOverviewData.tsx(async Server Component、JSXを返す) —
 *     中身はlistListingsOverviewSafe(lib/listing/service.ts)を1回呼んで
 *     そのままpropsへ渡すだけの1行道なので、
 *     scripts/verify-listings-overview-service-boundary.tsで
 *     listListingsOverviewSafe自体を実際に呼んで検証する。
 *
 * 実行: node node_modules/tsx/dist/cli.mjs scripts/verify-listings-overview-table-logic.ts
 * (node_modulesはこのworktree専用のjunctionでメインチェックアウトから
 * 借用——コミット対象外。CI/他worktreeでは`npm install`または同等の
 * junctionを別途用意すること。)
 */
import assert from "node:assert/strict";
import {
  LISTINGS_OVERVIEW_PAGE_SIZE,
  clampPage,
  paginate,
  selectableInventoryIds,
  loadStateFromInitialRows,
} from "@/lib/listing/listingsOverviewTableLogic";

let passes = 0;
let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) {
    passes++;
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`✗ FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log(`── paginate/clampPage (PAGE_SIZE=${LISTINGS_OVERVIEW_PAGE_SIZE}) ──`);

{
  // 364件相当(仕様の実測レンジ348〜364件をカバー)——複数ページに跨る。
  const items = Array.from({ length: 364 }, (_, i) => i);
  const p0 = paginate(items, 0, 100);
  check(p0.pageRows.length === 100 && p0.pageRows[0] === 0 && p0.pageRows[99] === 99, "★要件: 1ページ目は先頭100件");
  check(p0.pageCount === 4, "★要件: 364件はPAGE_SIZE=100で4ページ", `pageCount=${p0.pageCount}`);
  check(p0.totalCount === 364, "totalCountは絞り込み後の全件数(ページング前)");

  const p3 = paginate(items, 3, 100);
  check(p3.pageRows.length === 64 && p3.pageRows[0] === 300, "★要件: 最終ページは端数(64件)だけを返す", `len=${p3.pageRows.length}`);

  // ページ番号が範囲外(検索で件数が減った直後の古いページ等)→クランプする。
  const pOver = paginate(items, 99, 100);
  check(pOver.page === 3, "★要件: 範囲外のページ要求は最終ページへクランプする", `page=${pOver.page}`);
  const pNeg = paginate(items, -5, 100);
  check(pNeg.page === 0, "負のページ要求は0へクランプする");
}

{
  // 0件 → 空ページだが「該当する商品がありません」であって例外ではない。
  const p = paginate([] as number[], 0, 100);
  check(p.pageRows.length === 0 && p.pageCount === 1 && p.totalCount === 0, "★要件: 0件でもpageCount>=1(0除算/負のページ数にならない)");
}

check(clampPage(2, 1) === 0, "clampPage: pageCount=1なら常に0へ");
check(clampPage(0, 5) === 0, "clampPage: 範囲内はそのまま");

console.log("\n── selectableInventoryIds ──");
{
  const rows = [
    { inventoryId: "a", hasDraft: false },
    { inventoryId: "b", hasDraft: true },
    { inventoryId: "c", hasDraft: false },
  ];
  const ids = selectableInventoryIds(rows);
  check(ids.length === 2 && ids.includes("a") && ids.includes("c") && !ids.includes("b"), "★要件: 既に下書きがある行(hasDraft)は対象から除外する", JSON.stringify(ids));
}
{
  // ★要件(レビュー補正§4「一括操作対象の意図せぬ拡大縮小を防ぐ」):
  // ページングを導入しても、対象は「絞り込み後の全件」であって
  // 「現在ページに写っている行」に縮んでいないことを、364件規模で確認する。
  const filtered = Array.from({ length: 364 }, (_, i) => ({ inventoryId: `inv-${i}`, hasDraft: i % 5 === 0 }));
  const ids = selectableInventoryIds(filtered);
  const expectedCount = filtered.filter((r) => !r.hasDraft).length;
  check(ids.length === expectedCount, "★要件: 選択対象はページ内(100件)ではなく絞り込み後の全件(364件)から算出する", `ids=${ids.length} expected=${expectedCount}`);
}

console.log("\n── loadStateFromInitialRows (EC一覧P1 実失敗分類 2026-09-13: ListingsOverviewLoadOutcome) ──");
{
  const ok = loadStateFromInitialRows({ ok: true, rows: [{ id: 1 }] });
  check(ok.kind === "ok" && (ok as { rows: unknown[] }).rows.length === 1, "配列(実データあり) → ok状態");
}
{
  const okEmpty = loadStateFromInitialRows({ ok: true, rows: [] as unknown[] });
  check(okEmpty.kind === "ok" && (okEmpty as { rows: unknown[] }).rows.length === 0, "★要件: 空配列(実0件)はerrorではなくok状態(0件表示との区別)");
}
{
  // ★要件(EC一覧P1 実失敗分類): 取得失敗はkind:"error"であって、単なる
  // true/falseではなく安全な分類情報(stage/kind)を持つ——UIはこれを見て
  // 認証切れ(kind:"auth-expired")/権限不足(kind:"auth-forbidden")/
  // それ以外かで振る舞いを変える。
  const err = loadStateFromInitialRows({ ok: false, failure: { stage: "channelListings", kind: "auth-expired" } });
  check(err.kind === "error", "★要件: 取得失敗はerror状態——実0件と混同しない");
  check(
    err.kind === "error" && err.failure.stage === "channelListings" && err.failure.kind === "auth-expired",
    "★要件: 失敗段階(stage)と種別(kind)がそのままerror状態へ引き継がれる(UIの認証案内/局所再試行の出し分けに使う)",
  );
}
{
  // 2026-09-13補正(task_2c27a70778613453ed): このタスクの本題——権限
  // 不足(auth-forbidden)はauth-expiredと区別してそのまま引き継がれる。
  const err = loadStateFromInitialRows({ ok: false, failure: { stage: "listingDrafts", kind: "auth-forbidden" } });
  check(
    err.kind === "error" && err.failure.stage === "listingDrafts" && err.failure.kind === "auth-forbidden",
    "★要件: 権限不足(auth-forbidden)は認証切れ(auth-expired)と別のkindのまま引き継がれる(期限切れと断定しない)",
  );
}
{
  // stage不明(E2E fixture等、段階別計測が添えられていない失敗)でもerror状態自体は成立する。
  const err = loadStateFromInitialRows({ ok: false, failure: { stage: null, kind: "unknown" } });
  check(err.kind === "error" && err.failure.stage === null && err.failure.kind === "unknown", "★要件: 失敗段階が特定できない場合もstage:nullのままerror状態になる(timeout等へ決め打ちしない)");
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
