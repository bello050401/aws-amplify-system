/**
 * QA-006 検証: lib/inventory/sidebarFilterHref.ts の buildSidebarFilterHref。
 *
 * このworktreeにはnode_modulesが無く、next/react/server-onlyに依存する
 * モジュール(page.tsx/queries.ts等)は実行できないため、依存ゼロの純粋
 * 関数だけをNode単体(--experimental-strip-types)で直接検証する
 * (lib/inventory/listReturnParams.tsの検証方針と同じ)。
 *
 * 実行: node --experimental-strip-types scripts/qa006-verify-sidebarFilterHref.ts
 */
import { buildSidebarFilterHref } from "../lib/inventory/sidebarFilterHref.ts";

let failures = 0;
function assertEqual(actual: string, expected: string, label: string) {
  if (actual !== expected) {
    failures++;
    console.error(`NG  ${label}\n    expected: ${expected}\n    actual:   ${actual}`);
  } else {
    console.log(`OK  ${label}`);
  }
}

// 1. 実機再現の核心: adv/advanced+categoryIds切替でadv/advancedが消えない。
assertEqual(
  buildSidebarFilterHref({ categoryIds: ["cat-chair"], advanced: "1", adv: '{"combinator":"AND","conditions":[]}' }),
  "/inventory?categoryIds=cat-chair&advanced=1&adv=%7B%22combinator%22%3A%22AND%22%2C%22conditions%22%3A%5B%5D%7D",
  "カテゴリクリック時にadv/advancedを保持する",
);

// 2. quick検索(q)のみ、advanced/adv無し — 既存回帰。offset/limitは無い。
assertEqual(
  buildSidebarFilterHref({ q: "B000002", categoryIds: ["cat-chair"] }),
  "/inventory?q=B000002&categoryIds=cat-chair",
  "quick検索中のカテゴリ切替(既存回帰、advanced/adv無しなら付かない)",
);

// 3. 保管場所クリックでも同様にadv/advancedを保持する。
assertEqual(
  buildSidebarFilterHref({ categoryIds: ["cat-chair", "cat-sofa"], locationId: "loc-1", advanced: "1", adv: "{}" }),
  "/inventory?categoryIds=cat-chair%2Ccat-sofa&locationId=loc-1&advanced=1&adv=%7B%7D",
  "保管場所クリックでもadv/advancedを保持する(複数カテゴリOR選択も維持)",
);

// 4. 「すべて解除」= categoryIds:[] — カテゴリだけが消え、adv/advanced/qは残る。
assertEqual(
  buildSidebarFilterHref({ q: "abc", categoryIds: [], locationId: "loc-1", advanced: "1", adv: "{}" }),
  "/inventory?q=abc&locationId=loc-1&advanced=1&adv=%7B%7D",
  "「すべて解除」はカテゴリだけ外し、advanced/adv/qは維持する",
);

// 5. limit保持: 既定値(50相当="undefined")は付けない。100は付く。
assertEqual(
  buildSidebarFilterHref({ categoryIds: ["cat-chair"], limit: "100" }),
  "/inventory?categoryIds=cat-chair&limit=100",
  "表示件数100を絞り込み変更後も保持する(limit保持)",
);
assertEqual(
  buildSidebarFilterHref({ categoryIds: ["cat-chair"], limit: undefined }),
  "/inventory?categoryIds=cat-chair",
  "既定の表示件数(50)はURLに出さない",
);

// 6. offsetは受け取るキーにすら存在しない = 常にリセットされる(型レベルでも構築できない)。
assertEqual(buildSidebarFilterHref({}), "/inventory", "何も無ければ素の/inventory(offsetという概念が最初から無い)");

// 7. 何も指定が無い状態からのカテゴリクリック(既存の最も単純な回帰)。
assertEqual(buildSidebarFilterHref({ categoryIds: ["cat-1"] }), "/inventory?categoryIds=cat-1", "単純なカテゴリクリック(既存回帰)");

if (failures > 0) {
  console.error(`\n${failures}件失敗`);
  process.exit(1);
}
console.log("\n全件成功");
