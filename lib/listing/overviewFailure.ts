import type { StageTiming } from "@/lib/perf/queryTiming";

/**
 * EC一覧P1 実失敗分類(2026-09-13、task_12046ac60ecd86913c)。
 *
 * ## 背景 — 何が分からなかったか
 *
 * 公開後もユーザーの左メニューEC一覧が「読み込めませんでした」になる
 * 報告があったが(Codex別セッションでは同じ画面が364件を表示できており、
 * 「常に壊れている」わけではない)、それまでの実装は
 * `lib/listing/service.ts`の`listListingsOverviewSafe`が例外を
 * `console.warn(..., { error: err.name })`へ潰すだけだった。
 * `err.name`は4本の読み取りがどれも素朴な`new Error(...)`または
 * `JSON.stringify(errors)`で投げているため常に`"Error"`にしかならず、
 * 「4本のうちどれが失敗したか」「認証切れ/スロットリング/ネットワーク/
 * 想定外レスポンスのどれに近いか」が実運用ログからもUIからも一切
 * 分からなかった(このタスクの本題)。
 *
 * ## この分類の限界(正直に)
 *
 * ここは元の例外の`message`文字列に対するヒューリスティックであって、
 * AWS AppSync/DynamoDBの正確なエラーコード体系そのものではない
 * (lib/amplify/listAll.tsのunwrapList等がGraphQL errorsの`errorType`を
 * 落として`message`だけの`Error`へ変換しているため、この時点で
 * `errorType`はもう無い場合がある——それ自体を直すのは、多くの機能が
 * 共有するlib/amplify/listAll.tsへの変更になり、このタスクの隔離範囲を
 * 超える)。判定できない場合は"unknown"のまま返す — 「不明」を
 * "timeout"や他の具体的な種別に決め打ちしない(指示書§4)。根本原因
 * (AppSync/DynamoDB側で実際に何が起きたか)自体はこのヒューリスティック
 * だけでは未確定のまま — あくまで「次に同じ報告が来たときの当たりを
 * 付けやすくする」ための粗い分類。
 *
 * ## 2026-09-13 補正(task_2c27a70778613453ed): 権限不足を期限切れと断定しない
 *
 * 以前は"unauthorized"/"not authorized"/"forbidden"/"access denied"
 * (=権限が無い、というAppSyncの`@auth`ディレクティブ不一致の応答)と
 * "no current user"/"not signed in"/"token...expired"(=セッション/
 * 資格情報そのものが無い・切れている)を、どちらも単一の`"auth"`種別へ
 * まとめ、UI側で常に「認証の有効期限が切れている可能性があります。
 * 再度ログインしてください。」と案内していた。しかしAppSyncの
 * "Not Authorized to access X on type Y"は多くの場合、セッションは
 * 有効なままIAM/Cognitoのロールが対象操作を許可していないケースで返る
 * ——再ログインしても同じロールのままなので直らない。`"auth-expired"`
 * (再ログイン案内が有効)と`"auth-forbidden"`(権限不足、再ログインでは
 * 直らない)を分け、UI側の案内もそれぞれに合わせて出し分ける
 * (app/inventory/(protected)/listings/ListingsOverviewTable.tsx参照)。
 */

/** 一覧を組み立てる4本の並列読み取りのうちどれが失敗したか。lib/listing/service.tsのmeasureStage呼び出し名・fetchListingsOverviewRowsのタグ付け先と一致させる(固定ラベル、商品・顧客情報は含まない)。 */
export type ListingsOverviewFailureStage = "categoryNames" | "ecEligibleInventory" | "channelListings" | "listingDrafts";

/**
 * UIが振る舞いを変えるための安全な種別。原文・スタック・GraphQLメッセージ
 * 全文はここでは一切保持しない。
 *
 * - `auth-expired`: セッション/資格情報が無い・切れている(再ログインで
 *   直る見込みが高い)。
 * - `auth-forbidden`: 資格情報はあるが対象操作の権限が無い(再ログイン
 *   では直らない——ロール/権限設定側の問題)。
 */
export type ListingsOverviewFailureKind = "auth-expired" | "auth-forbidden" | "throttle" | "network" | "invalid-response" | "unknown";

export interface ListingsOverviewFailureInfo {
  /** 4本のうちどれで失敗したか特定できた場合のみ。計測/タグが添えられていない経路(E2E fixture等)ではnull。 */
  stage: ListingsOverviewFailureStage | null;
  kind: ListingsOverviewFailureKind;
}

/** 取得成功(行の配列)か失敗(安全な分類情報)かを表す、ページ/Server Action境界を安全に越えられる形。 */
export type ListingsOverviewLoadOutcome<T> = { ok: true; rows: T[] } | { ok: false; failure: ListingsOverviewFailureInfo };

/** 依存順(categoryNamesが先)。lib/listing/service.tsのecEligibleInventoryはcategoryNamesの取得を待ってから進むため、categoryNamesの失敗は必ずecEligibleInventoryへも伝播しうる——この並びが後段のfirstFailedStageの優先順位そのものになる。 */
const KNOWN_STAGES: readonly ListingsOverviewFailureStage[] = ["categoryNames", "ecEligibleInventory", "channelListings", "listingDrafts"];

function isKnownStage(stage: string): stage is ListingsOverviewFailureStage {
  return (KNOWN_STAGES as readonly string[]).includes(stage);
}

/**
 * `measureStage`(lib/perf/queryTiming.ts)が集めた段階別計測から、
 * 最初に失敗した段階を1つ拾う(計測有効時=`BELLO_QUERY_TIMING=1`の
 * 経路専用 ── 既定の通常経路は`taggedFailureStage`を使う、下記参照)。
 * 複数同時に失敗していても、UIは1つのメッセージしか出さないのでここ
 * では1件で足りる。
 *
 * ## 2026-09-13 補正(task_2c27a70778613453ed): 配列の並び順ではなく依存優先順で選ぶ
 *
 * 呼び出し元(lib/listing/service.tsのfetchListingsOverviewRowsWithStages)
 * が渡す`stages`配列は`[ecEligibleInventory, channelListings,
 * listingDrafts, categoryNames]`という、Promise.allに渡した順そのまま
 * (=categoryNamesが末尾)。`ecEligibleInventory`はcategoryNamesの取得
 * 結果を待ってから進み、categoryNamesが失敗していればその同じ例外を
 * 投げ直す(lib/listing/service.ts参照)ため、categoryNames失敗時は
 * 必ず`ecEligibleInventory`も`ok:false`になる。以前はここを配列の先頭
 * から`Array.prototype.find`していたため、根本原因の`categoryNames`
 * ではなく症状にすぎない`ecEligibleInventory`を「失敗段階」として
 * 誤表示していた。ここでは配列の並び順を無視し、`KNOWN_STAGES`の依存
 * 優先順(categoryNamesを先に確認)で最初に見つかった失敗を返す。
 */
export function firstFailedStage(stages: readonly StageTiming[]): ListingsOverviewFailureStage | null {
  const byStage = new Map(stages.filter((s) => isKnownStage(s.stage)).map((s) => [s.stage, s]));
  for (const stage of KNOWN_STAGES) {
    const timing = byStage.get(stage);
    if (timing && !timing.ok) return stage;
  }
  return null;
}

const FAILURE_STAGE_TAG = Symbol("bello.listingsOverviewFailureStage");

/**
 * 通常(計測OFF、fail-fast)経路専用: 最初に失敗した段階の名前だけを
 * 例外へ1つ付ける(2026-09-13 補正、task_2c27a70778613453ed)。
 *
 * `measureStage`のように4本ぶんの計測配列を集めて待つのではなく、
 * 各段階の`.catch`がその場で1回だけ呼ぶ——本来の`Promise.all`の
 * fail-fast契約(最初の失敗で即reject)を保ったまま、失敗段階の
 * 特定だけを可能にする(lib/listing/service.tsのfetchListingsOverviewRows
 * 参照)。
 *
 * 既にタグが付いていれば上書きしない ── categoryNamesの失敗が
 * ecEligibleInventory側の`.catch`へ伝播したとき、後から
 * "ecEligibleInventory"で上書きせず、根本の"categoryNames"を保つ
 * (firstFailedStageの依存優先順と同じ狙い)。
 */
export function tagListingsOverviewFailureStage<E>(error: E, stage: ListingsOverviewFailureStage): E {
  if (error && typeof error === "object" && !(FAILURE_STAGE_TAG in error)) {
    Object.defineProperty(error, FAILURE_STAGE_TAG, { value: stage, configurable: true, enumerable: false });
  }
  return error;
}

/** `tagListingsOverviewFailureStage`で付けたタグを取り出す。無ければnull。 */
export function taggedFailureStage(error: unknown): ListingsOverviewFailureStage | null {
  if (error && typeof error === "object" && FAILURE_STAGE_TAG in error) {
    const value = (error as Record<typeof FAILURE_STAGE_TAG, ListingsOverviewFailureStage>)[FAILURE_STAGE_TAG];
    return isKnownStage(value) ? value : null;
  }
  return null;
}

// lib/listing/mercari/errors.tsのclassifyGraphQLErrors/classifyHttpStatusと
// 同じヒューリスティック方針(HTTPステータス体系そのものではなく文字列
// マッチ)。Mercari向けとは別に定義している — こちらはAWS Amplify Data/
// AppSync/DynamoDB由来のエラーメッセージを対象にしており、語彙が違う。
//
// セッション/資格情報そのものが無い・切れている(再ログインで直る見込み)。
const AUTH_EXPIRED_PATTERN = /unauthenticated|no current user|not signed in|token.*(expired|invalid)|invalid.*token/i;
// 資格情報はあるが対象操作の権限が無い(AppSyncの@auth不一致等——再ログインでは直らない)。
const AUTH_FORBIDDEN_PATTERN = /unauthorized|not authorized|forbidden|access.?denied/i;
const THROTTLE_PATTERN = /throttl|rate exceeded|too many requests|provisionedthroughputexceeded|429/i;
const NETWORK_PATTERN = /network ?error|failed to fetch|fetch failed|econnrefused|enotfound|etimedout|ehostunreach|socket hang up|getaddrinfo/i;
const INVALID_RESPONSE_PATTERN = /unexpected token|unexpected end of json|(?:invalid|not valid) json/i;

/**
 * 元の例外を安全な種別へ分類する。`message`はここでのマッチにのみ使い、
 * 戻り値には含めない——呼び出し側(ログ/UI)には固定の種別コードだけが
 * 渡る。
 */
export function classifyListingsOverviewErrorKind(error: unknown): ListingsOverviewFailureKind {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (AUTH_EXPIRED_PATTERN.test(text)) return "auth-expired";
  if (AUTH_FORBIDDEN_PATTERN.test(text)) return "auth-forbidden";
  if (THROTTLE_PATTERN.test(text)) return "throttle";
  if (NETWORK_PATTERN.test(text)) return "network";
  if (INVALID_RESPONSE_PATTERN.test(text)) return "invalid-response";
  return "unknown";
}
