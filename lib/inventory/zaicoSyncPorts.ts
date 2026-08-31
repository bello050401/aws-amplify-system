import "server-only";
import type { Schema } from "@/amplify/data/resource";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { findOrCreateMasterEntryByName } from "./masters";
import { logInventoryHistory, type HistoryFieldChange } from "./history";
import { downloadAndImportInventoryImage, removeInventoryImage } from "./imageServerOps";
import type { InventoryImageRecord } from "./imageTypes";
import { buildZaicoSourceLinkId } from "./zaicoSyncEngine";

/**
 * Ports-and-adapters boundary for the ZAICO sync engine (BELLO統合改修
 * master指示書 Phase A: ZAICO background sync). `lib/inventory/
 * zaicoSync.ts`'s actual mapping/dedup/diff/image-merge business logic
 * (syncOneZaicoItem and everything it calls internally that ISN'T an AWS
 * call) is completely unchanged from before this refactor - only the
 * "how do I actually reach DynamoDB/AppSync/S3" glue is behind this
 * interface now, instead of being hardcoded to serverDataClient inline.
 *
 * Original goal was two adapters - this Next.js one, and a Lambda-side
 * one using an IAM-authenticated Data client for a scheduled background
 * worker. The Lambda adapter was NOT shipped: it requires model-level
 * function-resource authorization (`allow.resource(fn)`), which does
 * not work in @aws-amplify/data-schema@1.26.1 (the latest published
 * version) - confirmed by both a compile error and a runtime
 * `TypeError: allow.resource is not a function`, and by the package's
 * own source comment ("TODO: delete when we make resource auth
 * available at each level in the schema"). See amplify/data/resource.ts's
 * ZaicoSyncJob comment for the full writeup.
 *
 * This interface is still valuable without that second adapter:
 * - It's the one thing to implement once Amplify Gen2 ships that
 *   feature, without touching zaicoSync.ts again.
 * - It makes the sync engine's dedup/diff/mapping logic unit-testable
 *   against an in-memory mock port, which was not possible before (the
 *   old code called the real serverDataClient directly, inline).
 *
 * `createServerSyncPort()` is a thin wrapper around the EXISTING,
 * unmodified serverDataClient/masters.ts/history.ts/imageServerOps.ts
 * functions - byte-identical behavior to before this refactor, used by
 * every Server Action call site (the synchronous 1件/5件/全件 sync paths,
 * and the new checkpointed background-batch path in
 * lib/inventory/zaicoBackgroundSync.ts).
 *
 * ── 2026-08-29統合改修版での再調査(Q6: 「特定機能が使えなければ諦める
 * か? A. いいえ」への対応) ─────────────────────────────────────────
 * `allow.resource(fn)`が使えないことは確定済みだが、それ以外のAWS-native
 * 手段を実際に一つずつ検証した:
 *
 * 1. `backend.data.resources.tables`(型定義を実際に確認: node_modules/
 *    @aws-amplify/graphql-api-construct/lib/types.d.tsの
 *    `AmplifyGraphqlApiResources.tables: Record<string, ITable>`) は
 *    実在し、`generate-sku`が自前のCDKテーブルに対して既にやっている
 *    のと全く同じ`grantReadWriteData(fn)`を、Amplify Data自動生成の
 *    Inventory/Category/Location/InventoryHistory/ZaicoSyncJobテーブル
 *    に対しても行える。これはAppSync/GraphQLを完全に迂回する経路で、
 *    `allow.resource()`の不具合とは無関係に機能する。
 * 2. しかし、これを使うにはAppSyncのGraphQLレイヤーではなく生の
 *    DynamoDB Item形状(属性名・型・secondaryIndexes()由来のGSI用
 *    computed key属性)を直接読み書きする必要がある。ZaicoSyncJob
 *    (このアプリ自身が定義したフラットなschemaで、GSIも無い)であれば
 *    十分安全に手書きできる一方、Inventory(既存の本番データを持つ
 *    リッチなmodel、ChannelListing/ListingDraftのinventoryId GSI含む)
 *    に対して同じことをすると、GSI用computed属性の生成ロジックを
 *    ライブAWS環境で検証せずに手書きすることになり、「一見動くが
 *    実際は一覧・検索から見えなくなる」類の壊れ方をする実害リスクが
 *    ある(spec Q16: 「エラーや未完了を「完成」と誤認しない」に反する)。
 * 3. 「EventBridge Scheduler → Lambda → 既存のadvanceZaicoBackgroundSyncJob
 *    をNext.js Route Handler経由で叩く」案も検討した。しかし
 *    serverDataClient(generateServerClientUsingCookies)はNext.jsの
 *    受信リクエストのCookieヘッダから実際にサインイン中のCognito
 *    ユーザーのセッションを読む設計であり、EventBridgeからの
 *    サーバー間呼び出しにはそのセッションが存在しない。専用の
 *    「サービスアカウント」Cognitoユーザーを作り、その認証情報から
 *    得たJWTを固定のCookieヘッダとしてEventBridge Target設定へ埋め込み、
 *    Amplifyのトークン自動リフレッシュに賭けるという設計も理論上は
 *    組めるが、Amplify Next.js SSRアダプタの実際のCookie形式・
 *    リフレッシュ挙動をライブ環境なしに正しく組み立てられる確証が
 *    無く、これも同じQ16のリスクに該当する。
 *
 * 結論: 完全無人スケジュール実行そのものは、今回もLOCAL_IMPLEMENTED
 * まで到達できなかった — が、これは「調査せずに諦めた」のではなく、
 * 上記3つの具体的な選択肢をそれぞれ型定義・スキーマ設定まで確認した
 * 上で、残るリスクがライブAWS環境での検証なしには許容できないと判断
 * した結果である(BLOCKED_BY_EXTERNAL_SERVICE寄り — Amplify Gen2が
 * `allow.resource()`を実装するか、ユーザーがライブ環境での試行錯誤を
 * 許容する形で明示的に選択肢2または3を進めるかの、いずれかが必要)。
 * 一方で、lib/inventory/zaicoBackgroundSync.tsのチェックポイント方式
 * (ブラウザタブを開いている間は数十秒おきに自動継続、閉じても
 * 進行状況は失わずどこからでも再開可能)は、「1000件超を安定して処理
 * できる」「ブラウザを閉じてもデータが失われない」という実務要件は
 * 満たしている — 満たしていないのは「PCの電源を落としても続く」の
 * 一点のみであることを完了報告で明確に区別する。
 */

export type InventoryModel = Schema["Inventory"]["type"];

export interface NewInventoryInput {
  /** 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §11.7: claimSourceLinkで既に予約済みのid。Amplifyのcreateミューテーションはidを明示指定でき(ZaicoSyncJobの単一行idで既に使われている既存パターン)、これによりclaim〜実create間の窓を作らず、claim段階で確保したidをそのままInventoryの主キーにする。 */
  id: string;
  sku: string;
  name: string;
  categoryId?: string;
  locationId?: string;
  quantity: number;
  unit?: string;
  purchasePrice?: number;
  salePrice?: number;
  note?: string;
  barcode?: string;
  images: InventoryImageRecord[];
  customFields: string | undefined;
  createdBy: string;
  updatedBy: string;
  sourceSystem: string;
  sourceInventoryId: string;
  extendedFields: Record<string, unknown>;
}

export interface UpdateInventoryInput {
  id: string;
  name: string;
  categoryId?: string;
  locationId?: string;
  quantity?: number;
  unit?: string;
  note?: string;
  barcode?: string;
  purchasePrice?: number;
  salePrice?: number;
  images: InventoryImageRecord[];
  customFields: string | undefined;
  updatedBy: string;
  extendedFields: Record<string, unknown>;
}

/**
 * BELLO ZAICO級高速化仕様書 §30.7: Category/Locationの
 * findOrCreateがsyncOneZaicoItemから商品1件ごとに(unchangedでも)
 * 呼ばれ、その実装(lib/inventory/masters.tsのfindOrCreateMasterEntryByName)
 * が毎回`listAllMasterEntries`でマスタ全件を取得し直していた
 * (findExistingBySourceIdの全件Scan問題と並ぶ、もう1つの実N+1) —
 * このcacheをsyncOneZaicoItemへ渡すことで、1ページ(advanceZaicoBackgroundSyncJobの
 * 1回の呼び出し)内で同じカテゴリ/場所名が複数商品に現れても
 * マスタ取得は初出時の1回だけになる。空のMapで開始し、cache miss時
 * だけport.findOrCreateCategory/Locationを呼んで結果をcacheへ書き戻す
 * ——追加のprefetch専用port呼び出しを増やさない、最小変更の設計。
 */
export interface MasterCache {
  categories: Map<string, { id: string }>; // normalizeMasterName(name) -> entry
  locations: Map<string, { id: string }>;
}

export interface ClaimSourceLinkResult {
  claimed: boolean;
  /** claimed=falseのとき、既にこのsourceInventoryIdを保持している既存Inventoryのid。 */
  existingInventoryId?: string;
}

export interface ZaicoSyncPort {
  findExistingBySourceId(sourceInventoryId: string): Promise<InventoryModel | null>;
  /** One full scan of every ZAICO-managed BELLO record, keyed by sourceInventoryId - called once per sync run (Next.js: once per request; Lambda: once per batch tick), never once per item. */
  fetchAllZaicoManaged(): Promise<Map<string, InventoryModel>>;
  findOrCreateCategory(name: string): Promise<{ id: string; created: boolean }>;
  findOrCreateLocation(name: string): Promise<{ id: string; created: boolean }>;
  generateSku(): Promise<string>;
  createInventory(input: NewInventoryInput): Promise<InventoryModel>;
  updateInventory(input: UpdateInventoryInput): Promise<void>;
  logHistory(inventoryId: string, who: string | null, changes: HistoryFieldChange[]): Promise<void>;
  /** BELLO統合改修 master指示書 Phase B: also returns the generated list-view thumbnail's key (null if generation failed — never fatal, see lib/inventory/thumbnail.ts). */
  downloadAndImportImage(url: string): Promise<{ storageKey: string; thumbnailKey: string | null; originalHash: string }>;
  removeImage(path: string): Promise<void>;
  /**
   * 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §11.7: DB層での
   * 原子的な新規sourceInventoryId確保(ZaicoSourceLinkモデル、
   * amplify/data/resource.tsのコメント参照)。同じsourceInventoryIdへ
   * 2箇所が同時にclaimしようとしても片方しか成功しない
   * (Amplifyのcreateミューテーションの標準的な条件付き書き込みを
   * 利用——新規のDynamoDB直接操作パターンは導入していない)。
   */
  claimSourceLink(sourceInventoryId: string, inventoryId: string): Promise<ClaimSourceLinkResult>;
  /** createInventory失敗時の補償操作 — 確保したclaimを解放し、再試行を妨げない(既存のimage cleanupと同じ「失敗したら後始末する」規約)。 */
  releaseSourceLink(sourceInventoryId: string): Promise<void>;
}

/** Same scan semantics as lib/inventory/zaicoSync.ts's previous fetchAllZaicoManagedInventory - unchanged. */
async function serverFetchAllZaicoManaged(): Promise<Map<string, InventoryModel>> {
  const map = new Map<string, InventoryModel>();
  let nextToken: string | null | undefined;
  do {
    const { data, nextToken: nt } = await serverDataClient.models.Inventory.list({
      filter: { sourceSystem: { eq: "ZAICO" } },
      nextToken: nextToken ?? undefined,
      ...inventoryAuthMode,
    });
    for (const item of data) {
      if (item.deletedAt || !item.sourceInventoryId) continue;
      map.set(item.sourceInventoryId, item);
    }
    nextToken = nt;
  } while (nextToken);
  return map;
}

/**
 * The Next.js/cookie-based adapter - identical behavior to what
 * lib/inventory/zaicoSync.ts did inline before this refactor. Every
 * existing caller (the ADMIN-triggered 1件/5件/全件 sync Server Actions)
 * gets this by default, so their already-AWS-verified behavior is
 * unchanged.
 */
export function createServerSyncPort(): ZaicoSyncPort {
  return {
    async findExistingBySourceId(sourceInventoryId) {
      // 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §11.3/§11.4:
      // 実データで確認されたZAICO在庫ID重複("50666071"等)の根本原因
      // ——以前はここが`Inventory.list({filter})`単発呼び出し(nextToken
      // ループ無し)だった。sourceSystem/sourceInventoryIdはInventoryの
      // GSIに含まれておらず、この呼び出しは実質DynamoDB Scan+
      // FilterExpressionであり、単発呼び出しはテーブル全体ではなく
      // 1回のレスポンスに収まる範囲しか走査しない——Inventoryが増える
      // ほど、目的の行がこの範囲外に落ちて「既存が見つからない」と
      // 誤判定し、新規重複作成する実害があった。
      //
      // 一次手段: ZaicoSourceLinkの主キー直接get(スキャン不要、常に
      // 完全・即時)。リンクが存在しないレコード(このスキーマ変更より
      // 前に同期された既存ZAICO商品)向けのフォールバックとして、
      // 必ずnextTokenをループする完全スキャンを残す(このリポジトリの
      // 他の全件走査——fetchAllInventoryRecords等——と同じ規約)。
      const linkId = buildZaicoSourceLinkId("ZAICO", sourceInventoryId);
      const { data: link } = await serverDataClient.models.ZaicoSourceLink.get({ id: linkId }, inventoryAuthMode);
      if (link) {
        const { data: inv } = await serverDataClient.models.Inventory.get({ id: link.inventoryId }, inventoryAuthMode);
        if (inv && !inv.deletedAt) return inv;
        // リンクは存在するが参照先が壊れている(手動削除等) — リンクを
        // 信用せず、安全側のフォールバックスキャンへ進む。
      }
      let nextToken: string | null | undefined;
      do {
        const { data, nextToken: nt } = await serverDataClient.models.Inventory.list({
          filter: { and: [{ sourceSystem: { eq: "ZAICO" } }, { sourceInventoryId: { eq: sourceInventoryId } }] },
          nextToken: nextToken ?? undefined,
          ...inventoryAuthMode,
        });
        const hit = data.find((d) => !d.deletedAt);
        if (hit) return hit;
        nextToken = nt;
      } while (nextToken);
      return null;
    },
    async claimSourceLink(sourceInventoryId, inventoryId) {
      const linkId = buildZaicoSourceLinkId("ZAICO", sourceInventoryId);
      const { data: created, errors } = await serverDataClient.models.ZaicoSourceLink.create(
        { id: linkId, sourceSystem: "ZAICO", sourceInventoryId, inventoryId },
        inventoryAuthMode,
      );
      if (created && !errors) return { claimed: true };
      // create失敗——文字列一致に頼らず、実際に既存行を読みに行くことで
      // 「同時実行による既存claim」と「その他の予期しないエラー」を
      // 区別する(予期しないエラーは握りつぶさずthrowする)。
      const { data: existingLink } = await serverDataClient.models.ZaicoSourceLink.get({ id: linkId }, inventoryAuthMode);
      if (existingLink) return { claimed: false, existingInventoryId: existingLink.inventoryId };
      throw new Error(`ZAICO在庫ID ${sourceInventoryId} の重複防止claimに失敗しました: ${JSON.stringify(errors)}`);
    },
    async releaseSourceLink(sourceInventoryId) {
      const linkId = buildZaicoSourceLinkId("ZAICO", sourceInventoryId);
      const { errors } = await serverDataClient.models.ZaicoSourceLink.delete({ id: linkId }, inventoryAuthMode);
      // 失敗を握りつぶさない。
      //
      // ここはcreate失敗時の補償処理で、claimだけが残るとその在庫IDは
      // 「リンクはあるがInventoryが無い」不整合になり、以後の同期で
      // zaicoSyncEngineが毎回throwする——つまり**その1件は二度と
      // 取り込めなくなる**。実際にZAICO ID 48824174がこの状態で
      // 取り残されていた(5,312件中1件だけがBELLOに存在しない)。
      //
      // Amplifyのdeleteは失敗を例外ではなく errors で返すため、
      // awaitするだけでは成功と見分けが付かない。
      if (errors && errors.length > 0) {
        throw new Error(
          `ZAICO在庫ID ${sourceInventoryId} の重複防止リンクの解放に失敗しました(リンクだけが残る不整合になります): ${JSON.stringify(errors)}`,
        );
      }
    },
    fetchAllZaicoManaged: serverFetchAllZaicoManaged,
    findOrCreateCategory: (name) => findOrCreateMasterEntryByName("Category", name),
    findOrCreateLocation: (name) => findOrCreateMasterEntryByName("Location", name),
    async generateSku() {
      const { data: sku, errors } = await serverDataClient.mutations.generateInventorySku(inventoryAuthMode);
      if (errors || !sku) throw new Error(`SKUの発番に失敗しました: ${JSON.stringify(errors)}`);
      return sku;
    },
    async createInventory(input) {
      const { data: created, errors } = await serverDataClient.models.Inventory.create(
        {
          id: input.id,
          sku: input.sku,
          name: input.name,
          categoryId: input.categoryId,
          locationId: input.locationId,
          quantity: input.quantity,
          unit: input.unit,
          purchasePrice: input.purchasePrice,
          salePrice: input.salePrice,
          note: input.note,
          barcode: input.barcode,
          images: input.images,
          customFields: input.customFields,
          createdBy: input.createdBy,
          updatedBy: input.updatedBy,
          sourceSystem: input.sourceSystem,
          sourceInventoryId: input.sourceInventoryId,
          // 第六ラウンドP0-5(amplify/data/resource.tsのInventory
          // モデルコメント参照)。
          listingPartition: "ACTIVE",
          listUpdatedAt: new Date().toISOString(),
          ...input.extendedFields,
        },
        inventoryAuthMode,
      );
      if (errors || !created) throw new Error(`在庫の作成に失敗しました: ${JSON.stringify(errors)}`);
      return created;
    },
    async updateInventory(input) {
      const { errors } = await serverDataClient.models.Inventory.update(
        {
          id: input.id,
          name: input.name,
          categoryId: input.categoryId,
          locationId: input.locationId,
          quantity: input.quantity,
          unit: input.unit,
          note: input.note,
          barcode: input.barcode,
          purchasePrice: input.purchasePrice,
          salePrice: input.salePrice,
          images: input.images,
          customFields: input.customFields,
          updatedBy: input.updatedBy,
          // 第六ラウンドP0-5: ZAICO側の実データ変更を反映する更新なので
          // 一覧の並び順を最新化する対象。
          listUpdatedAt: new Date().toISOString(),
          ...input.extendedFields,
        },
        inventoryAuthMode,
      );
      if (errors) throw new Error(`在庫の更新に失敗しました: ${JSON.stringify(errors)}`);
    },
    logHistory: logInventoryHistory,
    downloadAndImportImage: downloadAndImportInventoryImage,
    removeImage: removeInventoryImage,
  };
}

/** Lazily constructed, reused across calls within the same Next.js request/process - matches how `serverDataClient` itself is already a module-level singleton. */
let cachedServerPort: ZaicoSyncPort | null = null;
export function getServerSyncPort(): ZaicoSyncPort {
  if (!cachedServerPort) cachedServerPort = createServerSyncPort();
  return cachedServerPort;
}
