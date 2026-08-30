/**
 * 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §11.5「全件監査」の
 * 純粋ロジック(グルーピング・正規候補選定)のstandalone verification。
 * 実DB呼び出しを伴う`runZaicoDuplicateAudit`/`mergeZaicoDuplicate`自体は
 * 他のverify-*.tsと同じ方針でAWS接続を要するため対象外。
 *
 * Run with: npm run verify:zaico-duplicate-audit
 */
import { groupZaicoDuplicates, summarizeZaicoDuplicateAudit, type ZaicoLinkedInventorySummary } from "@/lib/inventory/zaicoDuplicateAudit";

let failures = 0;
let passes = 0;

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ FAIL ${label}\n    expected: ${e}\n    actual:   ${a}`);
  } else {
    passes++;
    console.log(`✓ ${label}`);
  }
}

function makeRecord(overrides: Partial<ZaicoLinkedInventorySummary>): ZaicoLinkedInventorySummary {
  return {
    id: "inv-x",
    sku: "B000001",
    name: "テスト商品",
    sourceInventoryId: "1001",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    categoryId: null,
    locationId: null,
    ...overrides,
  };
}

function testNoDuplicatesReturnsEmpty() {
  const records = [makeRecord({ id: "inv-1", sourceInventoryId: "1001" }), makeRecord({ id: "inv-2", sourceInventoryId: "1002" })];
  const groups = groupZaicoDuplicates(records);
  assertEqual(groups, [], "重複が無い場合、groupZaicoDuplicatesは空配列を返す");
}

function testExactDuplicateExample() {
  // 実データで確認された実例(ZAICO在庫ID"50666071"、SKU例B000338)を
  // 象徴的に使う——実際のSKU値は問題の本質ではない(SKU重複ではなく
  // ZAICO在庫ID自体の重複)ことを、異なるSKUの2件として構成することで
  // 明示する。
  const older = makeRecord({ id: "inv-old", sourceInventoryId: "50666071", sku: "B000338", createdAt: "2026-06-01T00:00:00.000Z" });
  const newer = makeRecord({ id: "inv-new", sourceInventoryId: "50666071", sku: "B000512", createdAt: "2026-08-01T00:00:00.000Z" });
  const unrelated = makeRecord({ id: "inv-other", sourceInventoryId: "9999", sku: "B000999" });

  const groups = groupZaicoDuplicates([newer, older, unrelated]); // 入力順序は意図的にshuffle
  assertEqual(groups.length, 1, "50666071相当のグループが1つだけ検出される(無関係なレコードは含まれない)");
  assertEqual(groups[0].sourceInventoryId, "50666071", "検出されたグループのsourceInventoryIdが正しい");
  assertEqual(groups[0].records.map((r) => r.id), ["inv-old", "inv-new"], "グループ内はcreatedAt ASC(最古が先頭)で並ぶ");
  assertEqual(groups[0].suggestedCanonicalId, "inv-old", "正規候補は最も古い(=最初に作られた)レコード(§11.9のデフォルト方針)");
}

function testThreeWayDuplicateGroup() {
  const a = makeRecord({ id: "inv-a", sourceInventoryId: "2001", createdAt: "2026-01-01T00:00:00.000Z" });
  const b = makeRecord({ id: "inv-b", sourceInventoryId: "2001", createdAt: "2026-02-01T00:00:00.000Z" });
  const c = makeRecord({ id: "inv-c", sourceInventoryId: "2001", createdAt: "2026-03-01T00:00:00.000Z" });
  const groups = groupZaicoDuplicates([c, a, b]);
  assertEqual(groups.length, 1, "3件重複でも1グループとして検出される");
  assertEqual(groups[0].records.length, 3, "3件重複グループは3件全てを含む");
  assertEqual(groups[0].suggestedCanonicalId, "inv-a", "3件重複でも最古のレコードが正規候補");
}

function testMultipleGroupsSortedByAffectedCountDesc() {
  const twoGroup = [
    makeRecord({ id: "inv-1a", sourceInventoryId: "1001", createdAt: "2026-01-01T00:00:00.000Z" }),
    makeRecord({ id: "inv-1b", sourceInventoryId: "1001", createdAt: "2026-01-02T00:00:00.000Z" }),
  ];
  const threeGroup = [
    makeRecord({ id: "inv-2a", sourceInventoryId: "2001", createdAt: "2026-01-01T00:00:00.000Z" }),
    makeRecord({ id: "inv-2b", sourceInventoryId: "2001", createdAt: "2026-01-02T00:00:00.000Z" }),
    makeRecord({ id: "inv-2c", sourceInventoryId: "2001", createdAt: "2026-01-03T00:00:00.000Z" }),
  ];
  const groups = groupZaicoDuplicates([...twoGroup, ...threeGroup]);
  assertEqual(
    groups.map((g) => g.sourceInventoryId),
    ["2001", "1001"],
    "影響件数が多いグループ(3件重複)が先、少ないグループ(2件重複)が後(最も深刻なものを最初に見せる)",
  );
}

function testSummaryCounts() {
  const records = [
    makeRecord({ id: "inv-1a", sourceInventoryId: "1001", createdAt: "2026-01-01T00:00:00.000Z" }),
    makeRecord({ id: "inv-1b", sourceInventoryId: "1001", createdAt: "2026-01-02T00:00:00.000Z" }),
    makeRecord({ id: "inv-2", sourceInventoryId: "2001" }), // 重複なし
  ];
  const summary = summarizeZaicoDuplicateAudit(100, records);
  assertEqual(summary.totalInventoryRecords, 100, "総Inventory件数がそのまま反映される(§11.5必須項目)");
  assertEqual(summary.zaicoLinkedRecords, 3, "ZAICO連携レコード件数(§11.5必須項目)");
  assertEqual(summary.duplicateGroupCount, 1, "重複グループ数(§11.5必須項目)");
  assertEqual(summary.duplicateAffectedRecordCount, 2, "重複グループに含まれる影響レコード総数(§11.5必須項目、正規候補1件+重複1件=2件)");
}

function testTieBreakOnIdenticalCreatedAt() {
  // 理論上稀だが、createdAtが完全に一致する場合はidで安定ソートする
  // (「毎回結果の順序が変わる」ことを避ける、compareByUpdatedAtDescと
  // 同じ考え方)。
  const a = makeRecord({ id: "inv-z", sourceInventoryId: "3001", createdAt: "2026-01-01T00:00:00.000Z" });
  const b = makeRecord({ id: "inv-a", sourceInventoryId: "3001", createdAt: "2026-01-01T00:00:00.000Z" });
  const groups = groupZaicoDuplicates([a, b]);
  assertEqual(groups[0].records.map((r) => r.id), ["inv-a", "inv-z"], "createdAtが同点の場合はidで安定ソートする");
}

function main() {
  testNoDuplicatesReturnsEmpty();
  testExactDuplicateExample();
  testThreeWayDuplicateGroup();
  testMultipleGroupsSortedByAffectedCountDesc();
  testSummaryCounts();
  testTieBreakOnIdenticalCreatedAt();
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
