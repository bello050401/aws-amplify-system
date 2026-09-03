/**
 * 未認証経路のDynamoDB直結façadeのうち、**式の組み立て**だけを固定する。
 * AWSには繋がない。
 *
 * ── なぜここを固定するか ────────────────────────────────────────
 *
 * UpdateExpression を1文字でも壊すと、DynamoDB は式全体を拒否する。
 * つまり**その経路の書き込みが1件も通らなくなる**。そして呼び出し側の
 * 多くは失敗を try/catch で「取得できなかった」に丸めているため、
 * 「データが無い」との区別が付かない形で消える。
 *
 * 実際に起きたこと: BASEのOAuthトークン更新が updatedAt を明示的に
 * 渡しており、こちらも updatedAt を必ず付けていたため、同じ属性へ
 * 別々のプレースホルダが2つ割り当たっていた。
 *
 *   ValidationException: Two document paths overlap with each other;
 *   path one: [updatedAt], path two: [updatedAt]
 *
 * 結果、トークン更新が通らず→BASE APIを呼べず→**取り込み済み267件以外の
 * 商品を一切特定できない**状態になっていた。画面には「特定できませんでした」
 * としか出ないため、原因に辿り着けない。
 *
 * Run with: npm run verify:direct-data
 */
import { buildUpdateExpression } from "@/lib/amplify/directData";

let passes = 0;
let failures = 0;
function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passes++;
    console.log(`✓ ${label}`);
  } else {
    failures++;
    console.log(`✗ ${label}\n    期待: ${e}\n    実際: ${a}`);
  }
}
const assertTrue = (c: boolean, label: string) => assertEqual(c, true, label);

const NOW = "2026-09-03T10:00:00.000Z";

/** 同じ属性が2つの経路で式へ入らないこと。 */
function testNoOverlappingPaths() {
  const { expression, names, values } = buildUpdateExpression(
    { accessToken: "a", refreshToken: "b", updatedAt: "2020-01-01T00:00:00.000Z" },
    NOW,
  );
  const attrs = Object.values(names);
  assertEqual(
    attrs.length,
    new Set(attrs).size,
    "更新式: 同じ属性へ2つのプレースホルダを割り当てない",
  );
  assertEqual(attrs.filter((a) => a === "updatedAt").length, 1, "更新式: updatedAtは1回だけ現れる");
  assertEqual(values[":ua"], NOW, "更新式: updatedAtはサーバ側の時刻で上書きする(AppSyncと同じ)");
  assertTrue(
    !Object.values(values).includes("2020-01-01T00:00:00.000Z"),
    "更新式: 呼び出し側が渡したupdatedAtは使わない",
  );
  assertTrue(expression.startsWith("SET "), "更新式: SET句から始まる");
}

/** null は REMOVE、undefined は無視、値は SET。 */
function testSetRemoveIgnore() {
  const { expression, names, values } = buildUpdateExpression(
    { keep: "v", drop: null, ignore: undefined },
    NOW,
  );
  assertTrue(expression.includes("SET ") && expression.includes("REMOVE "), "更新式: SETとREMOVEを両方出せる");
  const attrs = Object.values(names);
  assertTrue(attrs.includes("keep") && attrs.includes("drop"), "更新式: 値とnullの両方を式へ入れる");
  assertTrue(!attrs.includes("ignore"), "更新式: undefinedは式へ入れない(AppSyncの省略と同じ)");
  assertTrue(
    !Object.keys(values).some((k) => values[k] === null),
    "更新式: nullはREMOVEなので値として渡さない",
  );
}

/** 更新対象が空でも updatedAt だけは必ず設定される。 */
function testEmptyInput() {
  const { expression, names } = buildUpdateExpression({}, NOW);
  assertEqual(expression, "SET #ua = :ua", "更新式: 更新項目が無くてもupdatedAtは設定する");
  assertEqual(Object.values(names), ["updatedAt"], "更新式: 空入力でも属性名はupdatedAtだけ");
}

/** 予約語・記号を含む属性名でもプレースホルダ経由なので壊れない。 */
function testReservedWords() {
  const { names, expression } = buildUpdateExpression({ status: "OK", name: "x" }, NOW);
  assertTrue(Object.values(names).includes("status"), "更新式: 予約語statusも属性名として扱える");
  assertTrue(!expression.includes(" status "), "更新式: 属性名を式へ直接埋め込まない");
}

testNoOverlappingPaths();
testSetRemoveIgnore();
testEmptyInput();
testReservedWords();

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
