/**
 * 第六ラウンドP0-5(lib/inventory/inventoryCursorList.ts)の純粋ロジック
 * standalone verification。実DynamoDB/AppSync呼び出しを含む
 * `listInventoryByListingPartitionCursor`自体はAWS接続が要るため対象外
 * (他のverify-*.tsと同じ方針)——ここではURL境界を越える
 * encode/decode、および「次へ」「前へ」の状態遷移という、旧HTTP 431
 * バグ(無制限にnextTokenを積み上げていた設計)の再発防止に直結する
 * bounded 2-tokenカーソル設計そのものを検証する。
 *
 * Run with: npm run verify:inventory-cursor
 */
import {
  INITIAL_CURSOR_STATE,
  advanceCursorState,
  retreatCursorState,
  encodeCursorState,
  decodeCursorState,
  type CursorPaginationState,
} from "@/lib/inventory/inventoryCursorList";

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

function testAdvanceCursorState() {
  // 1ページ目→2ページ目: curが無かった状態からtoken1を得た。
  const s1 = advanceCursorState(INITIAL_CURSOR_STATE, "token1");
  assertEqual(s1, { cur: "token1", prev: null }, "advance: page1 -> page2");

  // 2ページ目→3ページ目: 新しいcurはtoken2、prevは旧cur(token1)へスライド。
  const s2 = advanceCursorState(s1, "token2");
  assertEqual(s2, { cur: "token2", prev: "token1" }, "advance: page2 -> page3");

  // 3ページ目→4ページ目: 状態のサイズは常に2トークンのまま増えない
  // (旧HTTP 431バグ——無制限に積み上げる設計——の再発防止そのもの)。
  const s3 = advanceCursorState(s2, "token3");
  assertEqual(s3, { cur: "token3", prev: "token2" }, "advance: page3 -> page4 (状態サイズは常に2トークンのまま)");

  // 最終ページ(nextTokenがnull)まで進んでも壊れない。
  const sLast = advanceCursorState(s3, null);
  assertEqual(sLast, { cur: null, prev: "token3" }, "advance: 最終ページ(nextToken=null)でも状態が壊れない");
}

function testRetreatCursorState() {
  // 1ページ目からは戻れない。
  assertEqual(retreatCursorState(INITIAL_CURSOR_STATE), null, "retreat: 1ページ目からは戻れない(null)");

  // 2ページ目→1ページ目: prevが無い(null)状態=1ページ目に戻る。
  const page2State: CursorPaginationState = { cur: "token1", prev: null };
  assertEqual(retreatCursorState(page2State), { cur: null, prev: null }, "retreat: page2 -> page1");

  // 3ページ目→2ページ目: prev(token1)がcurへスライドし、新prevはnull
  // (=「さらにもう1段前へ」はサポートしない、ファイル冒頭コメント通りの
  // 意図的な制約 — 2段以上前へは戻れない)。
  const page3State: CursorPaginationState = { cur: "token2", prev: "token1" };
  assertEqual(retreatCursorState(page3State), { cur: "token1", prev: null }, "retreat: page3 -> page2(新prevはnull、2段先へは戻れない)");
}

function testEncodeDecodeRoundTrip() {
  const cases: CursorPaginationState[] = [
    INITIAL_CURSOR_STATE,
    { cur: "token1", prev: null },
    { cur: "token2", prev: "token1" },
    { cur: null, prev: "token3" },
  ];
  for (const state of cases) {
    const encoded = encodeCursorState(state);
    const decoded = decodeCursorState(encoded);
    assertEqual(decoded, state, `encode/decode round-trip: ${JSON.stringify(state)}`);
  }

  // 初期状態は空文字列にエンコードされる(URLに余計なクエリパラメータを
  // 残さないため)。
  assertEqual(encodeCursorState(INITIAL_CURSOR_STATE), "", "encode: 初期状態は空文字列");

  // Base64はURLセーフ版であること('+'/'/' を含まない)。
  const encoded = encodeCursorState({ cur: "a+b/c=", prev: "d+e/f=" });
  assertEqual(/[+/]/.test(encoded), false, "encode: URLセーフBase64('+' '/' を含まない)");
}

function testDecodeMalformedInputFallsBackSafely() {
  // 壊れた/改ざんされた入力は例外を投げず、安全に初期状態へフォール
  // バックする(検索条件変更直後の古いカーソルパラメータが残っていても
  // 単に1ページ目から出し直すだけで済むように——存在しないSKUで404に
  // するような失敗モードは意図的に避けている、ファイル冒頭コメント参照)。
  assertEqual(decodeCursorState(null), INITIAL_CURSOR_STATE, "decode: null入力は初期状態へ");
  assertEqual(decodeCursorState(undefined), INITIAL_CURSOR_STATE, "decode: undefined入力は初期状態へ");
  assertEqual(decodeCursorState(""), INITIAL_CURSOR_STATE, "decode: 空文字列は初期状態へ");
  assertEqual(decodeCursorState("not-valid-base64json!!!"), INITIAL_CURSOR_STATE, "decode: 不正なBase64は初期状態へフォールバック(例外を投げない)");
  assertEqual(decodeCursorState(Buffer.from('{"not":"an array"}', "utf-8").toString("base64url")), INITIAL_CURSOR_STATE, "decode: 配列以外のJSONは初期状態へフォールバック");
  assertEqual(decodeCursorState(Buffer.from("[1,2,3]", "utf-8").toString("base64url")), INITIAL_CURSOR_STATE, "decode: 要素数不一致の配列は初期状態へフォールバック");
  assertEqual(decodeCursorState(Buffer.from("[1,2]", "utf-8").toString("base64url")), INITIAL_CURSOR_STATE, "decode: 要素の型が不正(文字列/nullでない)な配列は初期状態へフォールバック");
}

function main() {
  testAdvanceCursorState();
  testRetreatCursorState();
  testEncodeDecodeRoundTrip();
  testDecodeMalformedInputFallsBackSafely();
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
