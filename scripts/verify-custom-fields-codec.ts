/**
 * lib/inventory/customFieldsCodec.ts の回帰テスト
 * (2026-09-09 追加指示 item1: 商品72630786の詳細/編集で追加項目が
 * 「0」「1」等をキーとした文字表示になる不具合)。
 *
 * 原因: `Inventory.customFields` の実データの一部が、通常の
 * JSON文字列(1回だけJSON.stringifyされたもの)ではなく、**二重に
 * JSON文字列化された文字列**だった。旧 parseCustomFields は「文字列なら
 * 1回だけ JSON.parse する」実装で、二重エンコードの場合は
 * `JSON.parse('"{\"a\":1}"')` の結果である**文字列そのもの**を
 * `Record<string, unknown>` として返していた。呼び出し側
 * (InventoryFactsPanel.tsx / [id]/page.tsx など)はこれを
 * `Object.entries(...)` や spread で扱うため、文字列を走査すると
 * 1文字ごとに "0", "1", "2", ... というキーの行が出た。これが報告された
 * 症状。参考: C:/Users/win/Documents/Codex/2026-09-07/bello-qa-bello-claude-code-1/work/custom-fields-fix
 *
 * 実データは一切更新しない。この検査は parseCustomFields/stringifyCustomFields
 * という純粋関数だけを対象にする。
 *
 * Run with:
 *   node --input-type=module -e "<registerHooksでserver-onlyをstub + @/解決>" \
 *     'await import("./scripts/verify-custom-fields-codec.ts")'
 *   (memory: qa-worktree-tooling-limits — このworktreeにnode_modulesが無く
 *    npm run / tsx が使えないため、Node 24の型ストリップで直接実行する。
 *    customFieldsCodec.ts は "server-only" をimportするので、通常の
 *    with-server-only-stub.cjs 相当の対策として registerHooks の load
 *    フックで "server-only" を空モジュールへ差し替える。)
 *   または: node <mainrepo>/scripts/with-server-only-stub.cjs
 *     <このworktree>/scripts/verify-custom-fields-codec.ts
 *   でも動く(tsx利用)。ただしこの形式ではtsxの`@/*`解決がcwd(=mainrepo)
 *   基準になるため、下のインポートは相対パスで書く —— `@/`のままだと
 *   本体repo側の同名ファイル(このタスクの変更が入っていない版)へ解決され、
 *   worktreeでの修正が検査されないまま合格/不合格が決まってしまう
 *   (2026-09-10 再検収: verify-intro-validatorで実際に踏んだ不具合と同じ)。
 */
import { parseCustomFields, stringifyCustomFields } from "../lib/inventory/customFieldsCodec";

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
function assertTrue(cond: boolean, label: string) {
  assertEqual(cond, true, label);
}

// ── 空 ──────────────────────────────────────────────────────────────
function testEmpty() {
  assertEqual(parseCustomFields(null), null, "空: null入力はnull");
  assertEqual(parseCustomFields(undefined), null, "空: undefined入力はnull");
  assertEqual(parseCustomFields(""), null, "空: 空文字はnull");
  assertEqual(parseCustomFields("   "), null, "空: 空白だけの文字列はnull");
  assertEqual(parseCustomFields("{}"), {}, "空: 空オブジェクトのJSON文字列は{}(未知項目を捏造しない)");
  assertEqual(stringifyCustomFields(null), undefined, "空: stringify(null)はundefined");
  assertEqual(stringifyCustomFields({}), undefined, "空: stringify({})はundefined(空オブジェクトを書き込まない)");
}

// ── 通常のJSON文字列(1回だけJSON.stringifyされたもの。書き込み時の標準形) ──
function testNormalJsonString() {
  const known = { 座面高: "44", 材質: "オーク無垢材", 備考: "" };
  const raw = JSON.stringify(known);
  const parsed = parseCustomFields(raw);
  assertEqual(parsed, known, "JSON文字列: 通常の1回エンコードをそのまま復元する");
  assertTrue(parsed !== null && "座面高" in parsed && "材質" in parsed, "JSON文字列: 既知フィールドを失わない");

  // 未知の(定義されていない)キーが含まれていても、そのまま維持する
  // (§定義に無いキーを黙って捨てない=「未知項目を失わない」)。
  const withUnknownKey = { 座面高: "44", 将来追加された謎フィールド: "値" };
  const parsed2 = parseCustomFields(JSON.stringify(withUnknownKey));
  assertEqual(parsed2, withUnknownKey, "JSON文字列: 定義未追跡のキーも保持する(未知項目を失わない)");
}

// ── 二重エンコード(報告された不具合の実体) ──────────────────────────
function testDoubleEncoded() {
  const known = { 座面高: "44", 材質: "オーク無垢材" };
  const oncePreserved = JSON.stringify(known);
  const twiceEncoded = JSON.stringify(oncePreserved); // 文字列を、もう一度JSON文字列化した文字列
  const parsed = parseCustomFields(twiceEncoded);
  assertEqual(parsed, known, "二重エンコード: 2回分JSON.parseしてオブジェクトへ戻す");
  assertTrue(typeof parsed !== "string", "二重エンコード: 戻り値が文字列のままにならない(0/1キー分裂の直接原因を塞ぐ)");

  // 三重エンコードも(実測は二重だったが、guardは5回まで許容している)。
  const thrice = JSON.stringify(twiceEncoded);
  assertEqual(parseCustomFields(thrice), known, "三重エンコード: guardの範囲内なら復元できる");
}

// ── 不正JSON ─────────────────────────────────────────────────────────
function testInvalidJson() {
  assertEqual(parseCustomFields("{不正なJSON"), null, "不正JSON: パース不能な文字列はnullに退避する(例外を投げない)");
  assertEqual(parseCustomFields("{\"a\": }"), null, "不正JSON: 値が欠けた壊れたJSONもnull");
  assertEqual(parseCustomFields("ただの文字列"), null, "不正JSON: JSONとして解釈できないプレーンな文字列はnull");
}

// ── 配列 ─────────────────────────────────────────────────────────────
function testArray() {
  assertEqual(parseCustomFields(JSON.stringify(["a", "b", "c"])), null, "配列: JSON配列はオブジェクトではないのでnull(0/1キー分裂を再現させない)");
  assertEqual(parseCustomFields(["a", "b"]), null, "配列: 生の配列(既にparse済みの形)もnull");
}

// ── 既存object(すでにparse済みの状態で渡ってくるケース) ───────────────
function testAlreadyObject() {
  const known = { 座面高: "44" };
  assertEqual(parseCustomFields(known), known, "既存object: 既にオブジェクトならそのまま返す(再parseしようとしない)");

  // ネストした値(数値・null)も保つ。
  const mixed = { 数量: 3, 備考: null, 名称: "テスト" };
  assertEqual(parseCustomFields(mixed), mixed, "既存object: 数値・null・文字列が混在していてもそのまま保つ");
}

function main() {
  testEmpty();
  testNormalJsonString();
  testDoubleEncoded();
  testInvalidJson();
  testArray();
  testAlreadyObject();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
