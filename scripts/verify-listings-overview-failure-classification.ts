/**
 * EC一覧P1 実失敗分類(2026-09-13、task_12046ac60ecd86913c)の合成試験。
 * 2026-09-13 補正(task_2c27a70778613453ed): auth種別の分割
 * (auth-expired/auth-forbidden)・firstFailedStageの依存優先順・
 * タグベースの段階特定(taggedFailureStage)を追加検証する。
 *
 * lib/listing/overviewFailure.ts(依存は`type`importのみ——実行時は
 * lib/perf/queryTiming.tsを一切importしない、erasedなtype-only import)
 * を実際にimportして検証する。scripts/verify-listings-overview-table-
 * logic.tsと同じ位置付け(React/hooks/実AWS依存ゼロ、素のNode実行環境
 * からそのまま検証できる)。
 *
 * 検証する要件(タスク指示書§7「段階別throwとGraphQL errors、認証失敗、
 * throttle、未知例外、undefined戻り」の分類ロジック側):
 *   1. セッション/資格情報が無い・切れている(no current user/token
 *      expired等)は"auth-expired"へ分類される(再ログイン案内が有効)。
 *   1'. 資格情報はあるが権限が無い(Not Authorized/Forbidden/Access
 *      Denied等)は"auth-forbidden"へ分類される——★要件(このタスクの
 *      本題): 権限不足を単なる期限切れと断定しない。再ログイン案内は
 *      出さない(app/inventory/(protected)/listings/
 *      ListingsOverviewTable.tsx参照)。
 *   2. スロットリング(rate exceeded/too many requests/
 *      ProvisionedThroughputExceeded等)は"throttle"へ分類される。
 *   3. ネットワーク断(fetch failed/ECONNREFUSED等)は"network"へ分類される。
 *   4. 想定外レスポンス(Unexpected token等のJSON解析エラー)は
 *      "invalid-response"へ分類される。
 *   5. ★要件: どれにも当てはまらない例外は"unknown"のまま——
 *      "timeout"等へ決め打ちしない(指示書§4)。
 *   6. `firstFailedStage`は、依存優先順(categoryNamesが先)で最初の
 *      失敗を返す——配列の並び順ではない。未知の(想定外の)stage文字列や
 *      stages自体が空の場合はnullを返す(存在しない値を捏造しない)。
 *   7. `tagListingsOverviewFailureStage`/`taggedFailureStage`は、
 *      通常(fail-fast)経路が使う単一段階タグの往復を保証する——既に
 *      タグがあれば上書きしない(categoryNames失敗の伝播をecEligible
 *      Inventoryが誤って上書きしない、このタスクの本題)。
 *
 * 実行: node --import ./scripts/tmp-alias-loader.mjs scripts/verify-listings-overview-failure-classification.ts
 * (このファイル自体は@/エイリアスの解決にtsxのフックを使うが、
 * lib/listing/overviewFailure.tsの実行時依存はゼロ(type-only import)
 * なので、対象コード自体は他のverify-listings-overview-*と違いtsxを
 * 要求しない——素のNodeのTypeScript strip-only modeで足りる。)
 */
import {
  classifyListingsOverviewErrorKind,
  firstFailedStage,
  tagListingsOverviewFailureStage,
  taggedFailureStage,
  type ListingsOverviewFailureStage,
} from "@/lib/listing/overviewFailure";
import type { StageTiming } from "@/lib/perf/queryTiming";

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

console.log("── classifyListingsOverviewErrorKind ──");

// ★要件1: セッション/資格情報そのものが無い・切れている → auth-expired。
check(classifyListingsOverviewErrorKind(new Error("Access Token has expired")) === "auth-expired", "token expired → auth-expired");
check(classifyListingsOverviewErrorKind(new Error("No current user")) === "auth-expired", "No current user(未サインイン) → auth-expired");

// ★要件1'(このタスクの本題): 権限不足を期限切れと断定しない → auth-forbidden。
// 実際にlib/amplify/listAll.tsのunwrapList/service.tsの各fetch関数が
// 組み立てる形(JSON.stringify(errors)にerrorType/messageが混ざる、
// もしくはAppSync標準の"Not Authorized to access X on type Y")の両方を
// 想定する。
check(
  classifyListingsOverviewErrorKind(new Error("出品状況の取得に失敗しました: Not Authorized to access ChannelListing on type Query")) === "auth-forbidden",
  "AppSync標準の\"Not Authorized\"文言 → auth-forbidden(★要件: 期限切れと断定しない)",
);
check(
  classifyListingsOverviewErrorKind(new Error(`在庫の取得に失敗しました(カテゴリ 椅子): [{"message":"...","errorType":"Unauthorized"}]`)) === "auth-forbidden",
  "errorType:\"Unauthorized\"を含むJSON文字列 → auth-forbidden",
);
check(classifyListingsOverviewErrorKind(new Error("Forbidden")) === "auth-forbidden", "\"Forbidden\" → auth-forbidden");
check(classifyListingsOverviewErrorKind(new Error("Access Denied")) === "auth-forbidden", "\"Access Denied\" → auth-forbidden");

// ★要件2: スロットリング。
check(classifyListingsOverviewErrorKind(new Error("GSI throttled")) === "throttle", "\"throttled\"を含む → throttle");
check(classifyListingsOverviewErrorKind(new Error("Rate exceeded")) === "throttle", "DynamoDBの\"Rate exceeded\" → throttle");
check(classifyListingsOverviewErrorKind(new Error("ProvisionedThroughputExceededException")) === "throttle", "ProvisionedThroughputExceededException → throttle");

// ★要件3: ネットワーク断。
check(classifyListingsOverviewErrorKind(new TypeError("fetch failed")) === "network", "fetch failed(Node標準のnetwork TypeError) → network");
check(classifyListingsOverviewErrorKind(new Error("connect ECONNREFUSED 127.0.0.1:443")) === "network", "ECONNREFUSED → network");

// ★要件4: 想定外レスポンス。
check(classifyListingsOverviewErrorKind(new SyntaxError("Unexpected token < in JSON at position 0")) === "invalid-response", "Unexpected token(JSON構文エラー) → invalid-response");

// ★要件5: 未知の例外はunknownのまま——timeout等へ決め打ちしない。
check(classifyListingsOverviewErrorKind(new Error("something went wrong")) === "unknown", "★要件: どれにも当てはまらないメッセージはunknownのまま(timeoutへ決め打ちしない)");
check(classifyListingsOverviewErrorKind(new Error("[e2e-fixture] simulated listListingsOverview transient failure (recovers on retry)")) === "unknown", "E2E fixtureの合成失敗メッセージもunknown(既存のe2e/listings-overview.spec.tsの汎用エラー文言表示と整合)");
check(classifyListingsOverviewErrorKind(undefined) === "unknown", "★要件: undefinedを渡しても例外にならずunknownを返す");
check(classifyListingsOverviewErrorKind("plain string throw") === "unknown", "Errorインスタンスでない値(文字列throw)でも例外にならずunknownを返す");

console.log("\n── firstFailedStage(依存優先順、計測ON経路) ──");
{
  const stages: StageTiming[] = [
    { stage: "categoryNames", elapsedMs: 5, ok: true },
    { stage: "ecEligibleInventory", elapsedMs: 8, ok: false },
    { stage: "channelListings", elapsedMs: 3, ok: true },
    { stage: "listingDrafts", elapsedMs: 4, ok: true },
  ];
  check(firstFailedStage(stages) === "ecEligibleInventory", "categoryNamesがok:trueならecEligibleInventoryをそのまま返す");
}
{
  // ★要件6(このタスクの本題): 配列の並び順(ecEligibleInventoryが先頭)
  // ではなく、依存優先順(categoryNamesが先)で選ぶ——categoryNames失敗が
  // ecEligibleInventoryへ伝播した場合、根本のcategoryNamesを返す。
  const stagesArrayOrderIsEcFirst: StageTiming[] = [
    { stage: "ecEligibleInventory", elapsedMs: 8, ok: false }, // categoryNames失敗の伝播による症状
    { stage: "channelListings", elapsedMs: 3, ok: true },
    { stage: "listingDrafts", elapsedMs: 4, ok: true },
    { stage: "categoryNames", elapsedMs: 5, ok: false }, // 根本原因
  ];
  check(
    firstFailedStage(stagesArrayOrderIsEcFirst) === "categoryNames",
    "★要件: categoryNamesとecEligibleInventoryが両方失敗している場合、配列の並び順に関係なく根本のcategoryNamesを返す(依存先の症状を根本と誤表示しない)",
  );
}
{
  const allOk: StageTiming[] = [
    { stage: "categoryNames", elapsedMs: 5, ok: true },
    { stage: "channelListings", elapsedMs: 3, ok: true },
  ];
  check(firstFailedStage(allOk) === null, "全段階ok:trueならnull(失敗段階なし)");
}
check(firstFailedStage([]) === null, "★要件: 計測自体が添えられていない(空配列)場合もnull——存在しない段階を捏造しない");
{
  // 想定外のstage文字列(将来的な実装ミス・別画面の計測が紛れ込んだ場合)
  // を安全側(null)へ倒す——UIへ未知のラベルをそのまま出さない。
  const unknownStage = [{ stage: "unexpectedStageName", elapsedMs: 1, ok: false }] as unknown as StageTiming[];
  check(firstFailedStage(unknownStage) === null, "★要件: 未知のstage文字列は既知の4値へ寄せず、nullとして扱う(捏造しない)");
}
{
  const knownStages: ListingsOverviewFailureStage[] = ["categoryNames", "ecEligibleInventory", "channelListings", "listingDrafts"];
  check(knownStages.length === 4, "既知の4段階ラベルが揃っている(型の変更に追従する回帰確認)");
}

console.log("\n── tagListingsOverviewFailureStage / taggedFailureStage(通常fail-fast経路) ──");
{
  const err = new Error("boom");
  const tagged = tagListingsOverviewFailureStage(err, "channelListings");
  check(tagged === err, "タグ付けは元の例外インスタンスをそのまま返す(コピーしない)");
  check(taggedFailureStage(err) === "channelListings", "付けたタグをそのまま読み出せる");
}
{
  // ★要件7(このタスクの本題): 既にタグが付いていれば上書きしない——
  // categoryNames失敗がecEligibleInventory側の.catchへ伝播したとき、
  // 後から"ecEligibleInventory"で上書きせず根本を保つ。
  const err = new Error("category down");
  tagListingsOverviewFailureStage(err, "categoryNames");
  tagListingsOverviewFailureStage(err, "ecEligibleInventory"); // 伝播先が誤って上書きしようとする想定
  check(taggedFailureStage(err) === "categoryNames", "★要件: 既にタグがあれば上書きしない(根本のcategoryNamesを保つ)");
}
check(taggedFailureStage(new Error("no tag")) === null, "タグが無い例外はnullを返す");
check(taggedFailureStage(undefined) === null, "undefinedを渡しても例外にならずnullを返す");
check(taggedFailureStage("plain string") === null, "文字列throwでも例外にならずnullを返す");

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
