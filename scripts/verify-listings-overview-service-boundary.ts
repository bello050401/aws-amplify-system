/**
 * EC一覧P1 レビュー補正(2026-09-13)の実境界試験。
 *
 * scripts/verify-inventory-history-boundary.tsと同じ設計 — 対象モジュール
 * (lib/listing/service.ts)自体は実物のままimportし、その1つ下の境界
 * (lib/amplify/dataClient.ts の serverDataClient)だけをmockへ差し替える
 * (scripts/__mocks__/listingsOverview.dataClient.mock.cjs)。
 *
 * 実行にはtsxが要る(実測): Node 24のTypeScript直接実行(strip-only
 * mode)はconstructor parameter property(lib/integrations/writeGuard.ts
 * — service.tsの依存グラフに実在)のような型情報を要る構文を非対応
 * ('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'で実際に落ちることを確認済み)
 * なので、単純な`node scripts/....ts`では最後まで通らない。このファイル
 * 自身のregisterHooks(mock差し替え)はtsxのフックと共存できる
 * (node:moduleのregisterHooksは複数登録を連鎖させる設計)ので、実行は
 * `node node_modules/tsx/dist/cli.mjs scripts/verify-listings-overview-service-boundary.ts`
 * (node_modulesはメインチェックアウトからのjunction、[[qa-worktree-tooling-limits]]参照)。
 *
 * lib/listing/service.tsはlistListingsOverviewの実行に不要な
 * publish系アダプタ(mercari/base)も冒頭でimportしているため、
 * next/headers・aws-amplify/storage/server・@aws-sdk/client-secrets-
 * managerという3つの実npmパッケージもモジュール解決の時点で要求される
 * ——scripts/__mocks__/stub-*.cjsへ差し替える(実際には一切呼ばれない、
 * 呼ばれたらthrowするスタブ)。
 *
 * 検証する要件(タスク指示書§4/§7「実関数の依存をmockした試験で
 * ページtoken/失敗/要求数を検証」):
 *   1. Category(GSI対象カテゴリ抽出)→ Inventory.listInventoryByCategoryId
 *      がカテゴリごとにnextTokenを辿り切る(250件のカテゴリで2ページに
 *      跨る)。
 *   2. ChannelListing/ListingDraftの一括Scanが limit=1000(旧200からの
 *      改善)で呼ばれる——109a97eから継承したlimit変更が実際に効いて
 *      いることの直接証拠。
 *   3. 対象外カテゴリ(「発送完了」)がGSI抽出の時点で現れないこと。
 *   4. いずれかの取得が失敗した場合、listListingsOverviewは例外を
 *      投げ、listListingsOverviewSafe(page.tsx用)はそれを外へ投げず
 *      `{ok:false, failure}`へ落とす(2026-09-13 EC一覧P1 実失敗分類、
 *      task_12046ac60ecd86913c)。
 *   4'. 2026-09-13 補正(task_2c27a70778613453ed): 既定(計測OFF)の
 *      通常UI経路はfail-fast——1本が失敗すれば、他の1本が未解決の
 *      Promiseのままでもlisting Overviewは速やかに失敗を返す(4本
 *      全部の決着を待たない)。categoryNames失敗がecEligibleInventory
 *      へ伝播しても、失敗段階は根本のcategoryNamesとして特定される。
 *   5. (2026-09-13 EC一覧の読取量削減)Category.listは1回の
 *      listListingsOverview呼び出しにつき1回だけ呼ばれる——以前は
 *      listEcEligibleInventoryとloadCategoryNameLookupがそれぞれ独立に
 *      Categoryを取得しており、実質2回叩いていた。
 *   6. ListingDraft.listのselectionSetがinventoryIdだけを要求し、
 *      description/imagesのような一覧に使わない大きめの列を運ばない。
 *
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

declare module "node:module" {
  export function registerHooks(hooks: {
    resolve?: (
      specifier: string,
      context: { parentURL?: string },
      nextResolve: (specifier: string, context: unknown) => unknown,
    ) => unknown;
  }): void;
}

const projectRoot = pathToFileURL(process.cwd() + "/").href;
const mocksDir = pathToFileURL(process.cwd() + "/scripts/__mocks__/").href;
const DATA_CLIENT_MOCK_URL = mocksDir + "listingsOverview.dataClient.mock.cjs";

const EXTERNAL_STUBS: Record<string, string> = {
  "server-only": mocksDir + "stub-server-only.cjs",
  "next/headers": mocksDir + "stub-next-headers.cjs",
  "aws-amplify/storage/server": mocksDir + "stub-aws-amplify-storage-server.cjs",
  "@aws-sdk/client-secrets-manager": mocksDir + "stub-aws-sdk-secrets-manager.cjs",
  // lib/amplify/requestCache.tsが`import * as React from "react"`する
  // (React.cacheが無ければ素通しする設計 — 同ファイルのコメント参照)。
  // 実物のreactパッケージが無いため空実装で足りる。
  react: mocksDir + "stub-react-minimal.cjs",
  "@aws-sdk/client-dynamodb": mocksDir + "stub-aws-sdk-dynamodb.cjs",
  "@aws-sdk/lib-dynamodb": mocksDir + "stub-aws-sdk-lib-dynamodb.cjs",
  "@aws-amplify/adapter-nextjs": mocksDir + "stub-amplify-adapter-nextjs.cjs",
  // lib/listing/mercari/adapter.ts(service.tsがcreateMercariProduct用に
  // importする)がlib/amplify/serverUtils.ts経由で@/amplify_outputs.jsonを
  // 実importする——publish系のこの1本を除きlistListingsOverviewの経路は
  // 使わないが、モジュール解決自体は通す必要がある。Node生ESMは(TSの
  // bundler解決と違い)拡張子付きのJSON importに`with { type: "json" }`
  // を要求する(ERR_IMPORT_ATTRIBUTE_MISSING)ため、.cjsの同型スタブへ
  // 差し替える。
  "@/amplify_outputs.json": mocksDir + "stub-amplify-outputs.cjs",
};

registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === "@/lib/amplify/dataClient") {
      return { url: DATA_CLIENT_MOCK_URL, shortCircuit: true };
    }
    if (specifier in EXTERNAL_STUBS) {
      return { url: EXTERNAL_STUBS[specifier], shortCircuit: true };
    }
    // "@/"エイリアス、および相対import("./..."/"../...")だけ、拡張子
    // 省略(.ts/.tsx — このリポジトリのソースはNode ESMが要求する明示
    // 拡張子を書いていない)を順に試す。それ以外のbare specifier
    // (パッケージ名)がここで見つからないのは、本当にnode_modulesに
    // 実体が無いという意味なので、そのまま失敗させる(末尾に".ts"/
    // ".tsx"を付けて再解決を試みると、例えば"react"のような未解決
    // パッケージが"react.tsx"という別の不可解なエラーに化けて原因が
    // 分かりにくくなる)。
    const isAlias = specifier.startsWith("@/");
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    if (!isAlias && !isRelative) {
      return nextResolve(specifier, context);
    }
    const target = isAlias ? projectRoot + specifier.slice(2) : specifier;
    try {
      return nextResolve(target, context);
    } catch {
      try {
        return nextResolve(target + ".ts", context);
      } catch {
        return nextResolve(target + ".tsx", context);
      }
    }
  },
});

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

async function main() {
  const { listListingsOverview, listListingsOverviewSafe } = await import("@/lib/listing/service");
  // cjs-module-lexerはこのfixtureの`module.exports = { ..., calls: {...}, ... }`
  // (ネストしたオブジェクトリテラルを含む)を静的解析しきれず、named exportの
  // 一部(calls/__resetCallLogs等)を取りこぼす(default以外の一部キーしか
  // 復元できない)ことを実測で確認した。`.default`は常にmodule.exports
  // そのもの(全プロパティ)を指すので、そちらを使う。
  const mock = (await import(DATA_CLIENT_MOCK_URL)).default;

  console.log("── listListingsOverview: ページtoken・要求数 ──────────────");
  {
    mock.__resetCallLogs();
    mock.__resetInventoryRejection();
    mock.__channelListingState.reset();
    mock.__listingDraftState.reset();

    const rows = await listListingsOverview();

    // ★要件1: 対象カテゴリ(チェア250件+デスク10件)のInventory.
    // listInventoryByCategoryIdが実際にnextTokenを辿り切っている
    // (チェアは200件区切りで2ページ、デスクは1ページ)。
    const chairCalls = mock.calls.inventory.filter((c: { key: { categoryId: string } }) => c.key.categoryId === "cat-chair");
    const deskCalls = mock.calls.inventory.filter((c: { key: { categoryId: string } }) => c.key.categoryId === "cat-desk");
    check(chairCalls.length === 2, "★要件: 250件のカテゴリはnextTokenで2ページ辿る(200件区切り)", `calls=${chairCalls.length}`);
    check(deskCalls.length === 1, "10件のカテゴリは1ページで完結", `calls=${deskCalls.length}`);
    check(chairCalls[0].opts.nextToken === undefined, "1ページ目はnextToken未指定");
    check(chairCalls[1].opts.nextToken === "200", "★要件: 2ページ目は1ページ目の続き(nextToken=200)を渡す", `nextToken=${chairCalls[1].opts.nextToken}`);

    // ★要件2(109a97eから継承したlimit改善の直接証拠): ChannelListing/
    // ListingDraftのScanがlimit=1000(旧200)で呼ばれている。
    check(
      mock.calls.channelListing.every((c: { limit: number }) => c.limit === 1000),
      "★要件: ChannelListing.listはlimit=1000で呼ぶ(109a97e由来のP1改善を継承)",
      JSON.stringify(mock.calls.channelListing.map((c: { limit: number }) => c.limit)),
    );
    check(
      mock.calls.listingDraft.every((c: { limit: number }) => c.limit === 1000),
      "★要件: ListingDraft.listはlimit=1000で呼ぶ",
      JSON.stringify(mock.calls.listingDraft.map((c: { limit: number }) => c.limit)),
    );

    // ★要件5(2026-09-13 EC一覧の読取量削減): Categoryは1回の一覧取得に
    // つき1回だけ——以前はlistEcEligibleInventoryとloadCategoryNameLookup
    // が独立に取得し、実質2回叩いていた。
    check(mock.calls.category.length === 1, "★要件: Category.listは1回のlistListingsOverviewにつき1回だけ呼ばれる(重複取得の解消)", `calls=${mock.calls.category.length}`);

    // ★要件6: ListingDraft.listのselectionSetはinventoryIdだけ——
    // description/images(a.json()の大きめの列)を一覧の存在判定のために
    // 運ばない。
    check(
      mock.calls.listingDraft.every((c: { selectionSet?: string[] }) => Array.isArray(c.selectionSet) && c.selectionSet.length === 1 && c.selectionSet[0] === "inventoryId"),
      "★要件: ListingDraft.listのselectionSetはinventoryIdだけを要求する",
      JSON.stringify(mock.calls.listingDraft.map((c: { selectionSet?: string[] }) => c.selectionSet)),
    );
    check(
      mock.calls.listingDraft.every((c: { selectionSet?: string[] }) => !c.selectionSet?.includes("description") && !c.selectionSet?.includes("images")),
      "★要件: ListingDraft.listのselectionSetにdescription/imagesが含まれない",
    );

    // ★要件3: 対象外カテゴリ(「発送完了」)はGSI抽出の時点で呼ばれない
    // (Category一覧には存在するが、Inventory.listInventoryByCategoryId
    // が呼ばれた形跡が無い)。
    const shippedCalls = mock.calls.inventory.filter((c: { key: { categoryId: string } }) => c.key.categoryId === "cat-shipped");
    check(shippedCalls.length === 0, "★要件: 対象外カテゴリ(発送完了)はInventory GSIすら引かない");

    // 正常系の中身も一応確認(260件のInventoryのうちChannelListing/
    // ListingDraftとjoinされ、対象外は含まれない)。
    check(rows.length === 260, "★要件: 対象カテゴリの全件(250+10)がjoin後も残る", `rows=${rows.length}`);
    check(!rows.some((r) => r.inventoryId.startsWith("cat-shipped")), "対象外カテゴリの行が紛れ込んでいない");
    const chairRow0 = rows.find((r) => r.inventoryId === "cat-chair-0");
    check(chairRow0?.channelListing?.status === "ACTIVE", "ChannelListingが実際にjoinされている(externalListingId等)");
    const deskRow0 = rows.find((r) => r.inventoryId === "cat-desk-0");
    check(deskRow0?.hasDraft === true, "ListingDraftの有無(hasDraft)が実際にjoinされている");
  }

  console.log("\n── 失敗の伝播: listListingsOverview vs listListingsOverviewSafe ──");
  {
    mock.__resetCallLogs();
    // Node標準fetch(undici)が接続できないときに実際に投げる形
    // ("TypeError: fetch failed")を模す——lib/listing/overviewFailure.ts
    // のNETWORK_PATTERNが対象にしている実際のエラー形。
    mock.__channelListingState.setRejection(new TypeError("fetch failed"));

    let threw = false;
    try {
      await listListingsOverview();
    } catch {
      threw = true;
    }
    check(threw, "★要件: ChannelListingの取得が失敗したらlistListingsOverviewは例外を投げる(0件と混同しない)");

    const safeResult = await listListingsOverviewSafe();
    check(safeResult.ok === false, "★要件: listListingsOverviewSafeは同じ失敗を外へ投げず{ok:false}へ落とす(ページ全体のerror境界へ波及させない)");
    // ★要件(EC一覧P1 実失敗分類、2026-09-13): BELLO_QUERY_TIMING未設定
    // (既定、本番の通常経路)でも段階(どの4本のうちどれが失敗したか)を
    // 特定できる——以前はここが常にnullだった(既定経路ではmeasureStage
    // 自体が使われていなかったため)。2026-09-13補正(task_2c27a70778613453ed)
    // では、これを`taggedFailureStage`(fail-fast、個別catchで1段階だけ
    // タグ付け)で実現している——4本全部の決着を待つmeasureStageは既定
    // 経路からは外れている。
    check(
      !safeResult.ok && safeResult.failure.stage === "channelListings",
      "★要件: 計測フラグ未設定でも失敗段階(channelListings)を特定できる(既定経路のstage分類、fail-fastのタグ付けで実現)",
      JSON.stringify(safeResult),
    );
    check(!safeResult.ok && safeResult.failure.kind === "network", "★要件: \"fetch failed\"というメッセージはkind:\"network\"へ分類される");

    mock.__channelListingState.reset();
  }

  {
    // GraphQL errors経由(reject ではなく {data, errors})でも同様に伝播する。
    mock.__resetCallLogs();
    mock.__listingDraftState.setErrors([{ message: "Not Authorized" }]);

    let threw = false;
    try {
      await listListingsOverview();
    } catch {
      threw = true;
    }
    check(threw, "GraphQL errors(ListingDraft)経由の失敗も例外として伝播する");

    const safeResult = await listListingsOverviewSafe();
    check(safeResult.ok === false, "GraphQL errors経由の失敗もlistListingsOverviewSafeは{ok:false}へ落とす");
    check(!safeResult.ok && safeResult.failure.stage === "listingDrafts", "★要件: GraphQL errors経由でも失敗段階(listingDrafts)を特定できる");
    // ★要件(このタスクの本題、task_2c27a70778613453ed): AppSyncの
    // "Not Authorized"は権限不足(auth-forbidden)であって、セッション
    // 期限切れ(auth-expired)と断定しない——UIの再ログイン案内はここでは
    // 出さない。
    check(!safeResult.ok && safeResult.failure.kind === "auth-forbidden", "★要件: GraphQL errorsの\"Not Authorized\"はkind:\"auth-forbidden\"へ分類される(期限切れと断定しない)");

    mock.__listingDraftState.reset();
  }

  {
    // Inventory GSI自体の失敗(Promise.allの一部が先に落ちるケース)も
    // 同様に伝播することを確認する。
    mock.__resetCallLogs();
    mock.__setInventoryRejection(new Error("GSI throttled"));

    let threw = false;
    try {
      await listListingsOverview();
    } catch {
      threw = true;
    }
    check(threw, "Inventory GSIの失敗(reject)も例外として伝播する");

    const safeResult = await listListingsOverviewSafe();
    check(safeResult.ok === false, "Inventory GSI失敗経由もlistListingsOverviewSafeは{ok:false}へ落とす");
    check(!safeResult.ok && safeResult.failure.stage === "ecEligibleInventory", "★要件: Inventory GSI失敗はecEligibleInventory段階として特定できる");
    check(!safeResult.ok && safeResult.failure.kind === "throttle", "★要件: \"GSI throttled\"はkind:\"throttle\"へ分類される");

    mock.__resetInventoryRejection();
  }

  {
    // ★要件(指示書§4「unknownをtimeoutと決めつけない」): 分類できない
    // メッセージはkind:"unknown"のまま——他の具体的な種別へ寄せない。
    mock.__resetCallLogs();
    mock.__channelListingState.setRejection(new Error("something unexpected happened"));

    const safeResult = await listListingsOverviewSafe();
    check(safeResult.ok === false, "分類不能な例外もlistListingsOverviewSafeは{ok:false}へ落とす");
    check(!safeResult.ok && safeResult.failure.kind === "unknown", "★要件: 分類できないメッセージはkind:\"unknown\"のまま(timeout等へ決め打ちしない)");
    check(!JSON.stringify(safeResult).includes("something unexpected happened"), "★要件: listListingsOverviewSafeの戻り値に元の例外メッセージ原文が含まれない");

    mock.__channelListingState.reset();
  }

  console.log("\n── categoryNames失敗の誤表示防止(このタスクの本題、task_2c27a70778613453ed) ──");
  {
    // categoryNamesが失敗すると、ecEligibleInventory(categoryNamesの
    // 取得結果を待ってから進む)も同じ例外を受けて失敗する——このとき
    // 「失敗段階」は根本原因のcategoryNamesであるべきで、症状にすぎない
    // ecEligibleInventoryを誤って表示してはいけない(lib/listing/
    // service.tsのfetchListingsOverviewRowsのコメント参照)。
    mock.__resetCallLogs();
    mock.__categoryState.setRejection(new Error("Category master unavailable"));

    let threw = false;
    try {
      await listListingsOverview();
    } catch {
      threw = true;
    }
    check(threw, "Category取得の失敗も例外として伝播する");

    const safeResult = await listListingsOverviewSafe();
    check(safeResult.ok === false, "Category取得失敗もlistListingsOverviewSafeは{ok:false}へ落とす");
    check(
      !safeResult.ok && safeResult.failure.stage === "categoryNames",
      "★要件: categoryNames失敗はecEligibleInventoryへ伝播しても、根本のcategoryNamesとして特定される(依存先の症状を誤表示しない)",
      JSON.stringify(safeResult),
    );

    mock.__categoryState.reset();
  }

  console.log("\n── fail-fast: 1本が失敗し、別の1本が未解決のままでもSafeは速やかに失敗を返す(このタスクの本題) ──");
  {
    // 2026-09-13補正(task_2c27a70778613453ed)の核心試験: 先行タスクが
    // 既定経路もmeasureStage+Promise.all(4本全部の決着を待つ)へ一本化
    // していた退行を検出する——channelListingsを意図的に「永久に未解決」
    // にした状態でlistingDraftsだけを失敗させ、listListingsOverviewSafe
    // が(channelListingsの決着を待たず)速やかに{ok:false}を返すことを、
    // 実際にPromise.raceでタイムアウトと競わせて確認する。
    mock.__resetCallLogs();
    mock.__channelListingState.setNeverResolves();
    mock.__listingDraftState.setErrors([{ message: "Rate exceeded" }]);

    const TIMEOUT_MS = 2000;
    const timeoutMarker = Symbol("timeout");
    const startedAt = Date.now();
    const result = await Promise.race([
      listListingsOverviewSafe(),
      new Promise((resolve) => setTimeout(() => resolve(timeoutMarker), TIMEOUT_MS)),
    ]);
    const elapsedMs = Date.now() - startedAt;

    check(result !== timeoutMarker, `★要件: 1本(channelListings)が未解決のままでも、listListingsOverviewSafeは${TIMEOUT_MS}ms以内に決着する(全段階待ちへの退行なし)`, `elapsedMs=${elapsedMs}`);
    if (result !== timeoutMarker) {
      const safeResult = result as Awaited<ReturnType<typeof listListingsOverviewSafe>>;
      check(safeResult.ok === false, "fail-fastでも{ok:false}を返す");
      check(!safeResult.ok && safeResult.failure.stage === "listingDrafts", "★要件: 実際に失敗した段階(listingDrafts)を特定できる(未解決のchannelListingsではない)");
      check(!safeResult.ok && safeResult.failure.kind === "throttle", "\"Rate exceeded\"はkind:\"throttle\"へ分類される");
    }

    mock.__channelListingState.reset();
    mock.__listingDraftState.reset();
  }

  console.log("\n── 段階別の壁時計計測(BELLO_QUERY_TIMING=1、実service) ── elapsedMsと累積msの区別 ──");
  {
    // 2026-09-13 EC計測レビュー補正: listEcEligibleInventoryはカテゴリ
    // ごとに`Promise.all`で並列にGSIを叩く(chairは250件で2ページ、
    // deskは10件で1ページ)。合成遅延を与えて、ecEligibleInventory段階の
    // 壁時計(elapsedMs)が「chairの直列2往復ぶん」に近く、「chair2往復+
    // desk1往復を単純合計した累積ms」よりはっきり小さいことを、実際に
    // 待つ合成遅延(setTimeout)で示す ── 数値を演算で埋めた自己申告の
    // テストにしない。
    process.env.BELLO_QUERY_TIMING = "1";
    mock.__resetCallLogs();
    mock.__resetInventoryRejection();
    mock.__resetInventoryRejectAfterCalls();
    mock.__channelListingState.reset();
    mock.__listingDraftState.reset();
    mock.__categoryState.reset();

    // Windows既定のシステムタイマー分解能(≒15.6ms)により、setTimeoutの
    // 実測待ち時間は指定msの2倍近くまで丸め上がることを実測で確認した
    // (このsandbox環境固有の事情)。桁を1つ上げて、その揺らぎの範囲内でも
    // 「chairの直列2往復」と「完全直列(+desk1往復)」を明確に区別できる
    // 幅を確保する。
    const inventoryDelayMs = 80;
    const channelDelayMs = 80;
    const draftDelayMs = 80;
    mock.__setInventoryDelayMs(inventoryDelayMs);
    mock.__channelListingState.setDelayMs(channelDelayMs);
    mock.__listingDraftState.setDelayMs(draftDelayMs);

    const { listListingsOverviewWithTiming } = await import("@/lib/listing/service");
    const result = await listListingsOverviewWithTiming();

    mock.__resetInventoryDelayMs();
    mock.__channelListingState.reset();
    mock.__listingDraftState.reset();

    check(result.rows.length === 260, "計測ONでも通常どおり260件返す(計測は結果を変えない)", `rows=${result.rows.length}`);

    const ecStage = result.stages.find((s: { stage: string }) => s.stage === "ecEligibleInventory");
    const chanStage = result.stages.find((s: { stage: string }) => s.stage === "channelListings");
    const draftStage = result.stages.find((s: { stage: string }) => s.stage === "listingDrafts");
    check(!!ecStage && ecStage.ok === true && !!chanStage && !!draftStage, "4段階とも記録され、成功時はok:true");

    // chairはpage1→page2が直列(≒inventoryDelayMs*2)、deskは1往復のみ。
    // 両カテゴリはPromise.allで並列に走るので、段階全体の壁時計は
    // 「chairの直列2往復」にほぼ一致し、desk分がそのまま上乗せされる
    // ことはない ── 完全に直列(chair2往復+desk1往復=3往復ぶん)なら
    // 到達するはずの値より、はっきり下回ることを確認する。
    //
    // 「1往復ぶんの実測コスト」はchannelListings段階(同じ80ms遅延を
    // 1回だけ待つ)の実測値をそのまま単位として使う ── setTimeoutの
    // 実測待ち時間はOSのタイマー分解能で指定msから増減する(Windowsの
    // 既定は≒15.6ms刻み)ため、80という指定値そのものを基準にすると
    // 環境差でテストが揺れる。実測1往復ぶんを基準にすれば環境差を
    // 自動的に吸収できる。
    const perCallCostMs = chanStage!.elapsedMs;
    check(
      !!ecStage && perCallCostMs > 0 && ecStage.elapsedMs >= perCallCostMs * 1.3 && ecStage.elapsedMs < perCallCostMs * 2.7,
      `★要件: ecEligibleInventoryの壁時計はchairの直列2往復(実測1往復≒${perCallCostMs}ms換算で≒${perCallCostMs * 2}ms)に近く、chair+deskを完全直列に足した場合(≒${perCallCostMs * 3}ms)には届かない`,
      `elapsedMs=${ecStage?.elapsedMs}ms, 実測1往復=${perCallCostMs}ms`,
    );

    // 累積参考値(queryTotals)はlib/amplify/dataClient.tsのwithTiming
    // (serverDataClient.models.X.op()をProxyで包んでrecordQueryする既存
    // 機構、このタスクでは変更していない)経由で埋まる。このfixtureは
    // `@/lib/amplify/dataClient`自体を丸ごとモックへ差し替えているため
    // (ファイル冒頭コメント参照)recordQueryは呼ばれず、常に空配列になる
    // ── groupTimingsByOpの累積計算自体の正しさ(並列実行分がそのまま
    // 合算されること)は、withTimingの実配線に依存しない
    // scripts/verify-listings-overview-timing.ts側で実際に待つ合成遅延
    // により検証済み。ここでは「戻り値の形」だけ確認する。
    check(Array.isArray(result.queryTotals), "queryTotalsは配列として返る(このfixture経由では空配列 ── 上記コメント参照)");

    check(
      !!chanStage && chanStage.elapsedMs >= channelDelayMs * 0.7 && chanStage.elapsedMs < channelDelayMs * 3,
      "channelListings段階の壁時計は1往復ぶん相当に収まる(合計しても増えない)",
      `${chanStage?.elapsedMs}ms`,
    );
    check(!!draftStage && draftStage.elapsedMs >= draftDelayMs * 0.7, "listingDrafts段階の壁時計も実測できる", `${draftStage?.elapsedMs}ms`);

    delete process.env.BELLO_QUERY_TIMING;
  }

  console.log("\n── 途中ページ失敗(実service) ── 1本の失敗が他の段階の計測を巻き込まない ──");
  {
    // 2026-09-13 EC計測レビュー補正の核心: 以前は「fetchがthrowすると
    // 計測結果を組み立てず、診断GETは汎用errorのみで失敗段階が消える」
    // 問題があった。ここではchairの1ページ目(GSI呼び出し1回目)は成功
    // させ、2ページ目(3回目の呼び出し ── デスクの1回目と合わせて2回目
    // までは成功させる)で初めて失敗させ、「一覧の途中(ページング中)で
    // 失敗する」ケースを再現する。
    process.env.BELLO_QUERY_TIMING = "1";
    mock.__resetCallLogs();
    mock.__resetInventoryRejection();
    mock.__channelListingState.reset();
    mock.__listingDraftState.reset();

    const inventoryDelayMs = 15;
    mock.__setInventoryDelayMs(inventoryDelayMs);
    mock.__setInventoryRejectAfterCalls(2); // 1・2回目(chair page1, desk page1)は成功、3回目(chair page2)で失敗。

    const { listListingsOverview, listListingsOverviewWithTiming } = await import("@/lib/listing/service");
    const { buildTimingResponsePayload } = await import("@/lib/listing/listingsOverviewTimingResponse");
    const { getStageTimings } = await import("@/lib/perf/queryTiming");

    let caught: unknown;
    try {
      await listListingsOverview();
    } catch (err) {
      caught = err;
    }
    check(caught instanceof Error, "★要件: 途中ページ失敗もlistListingsOverviewは例外として投げる(既存の例外契約を維持)");

    const stagesOnFailure = getStageTimings(caught);
    check(
      stagesOnFailure.length === 4,
      "★要件: 4本すべての段階の計測が失われずに残る(以前は失敗した時点で計測結果を組み立てられなかった)",
      `stages=${JSON.stringify(stagesOnFailure)}`,
    );
    const failedStage = stagesOnFailure.find((s) => s.stage === "ecEligibleInventory");
    check(!!failedStage && failedStage.ok === false, "★要件: 失敗した段階(ecEligibleInventory、chairの2ページ目)はok:falseとして記録される");
    const otherStagesOk = stagesOnFailure.filter((s) => s.stage !== "ecEligibleInventory").every((s) => s.ok === true);
    check(otherStagesOk, "★要件: 失敗していない他の3段階(channelListings/listingDrafts/categoryNames)はok:trueのまま");

    const safeResult = await (await import("@/lib/listing/service")).listListingsOverviewSafe();
    check(safeResult.ok === false, "listListingsOverviewSafeは同じ失敗を外へ投げず{ok:false}へ落とす(タイミング計測が有効でも契約は変わらない)");
    check(!safeResult.ok && safeResult.failure.stage === "ecEligibleInventory", "★要件: 計測フラグON時も同じ失敗段階(ecEligibleInventory)がlistListingsOverviewSafeまで届く(firstFailedStage経由)");

    // 診断応答(実際にroute.tsのGETが使うのと同じ関数)も同じ形で返す。
    mock.__resetCallLogs();
    const { status, body } = await buildTimingResponsePayload(listListingsOverviewWithTiming);
    check(status === 500 && body.error === "listings_overview_failed", "診断応答も同じ失敗を種別ラベルで返す");
    const bodyStages = (body.stages ?? []) as { stage: string; ok: boolean }[];
    check(
      Array.isArray(bodyStages) && bodyStages.length === 4,
      "★要件: 診断応答にも4段階すべての計測が乗る(以前は汎用errorのみで失敗段階が消えていた)",
      `body.stages=${JSON.stringify(bodyStages)}`,
    );
    check(!JSON.stringify(body).includes("GSI throttled"), "★要件: 診断応答に元の例外メッセージ(GSI throttled)は含まれない");
    check(!("rows" in body), "診断応答にrows(一覧の行)を含めていない");

    mock.__resetInventoryDelayMs();
    mock.__resetInventoryRejectAfterCalls();
    mock.__resetInventoryRejection();
    delete process.env.BELLO_QUERY_TIMING;
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
