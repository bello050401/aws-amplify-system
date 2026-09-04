import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { generateSku } from "../functions/generate-sku/resource";

/**
 * Data model for this Amplify app. Two independent systems share one
 * AppSync API and one Cognito User Pool (see amplify/auth/resource.ts):
 *
 * 1. The BASE feature-page generator (Feature / FeatureItem /
 *    BaseItemCache / BaseOAuthToken below) — unchanged from Phase 1,
 *    still "Admins" group + public API-key read.
 * 2. BELLO Inventory (Category / Location / StatusMaster /
 *    CustomFieldDefinition / Inventory / InventoryHistory, added in
 *    Phase 2, further down this file) — ADMIN/EDITOR/VIEWER groups only,
 *    no public access at all. See that section's own comment for why.
 *    `generateInventorySku` is a custom mutation in this same section,
 *    backed by a Lambda (amplify/functions/generate-sku) for race-free
 *    SKU auto-numbering.
 *
 * Design rule for the BASE side (per spec §6): BASE is the system of
 * record for price, stock, title, images, and visibility. This schema
 * never duplicates that data onto a Feature — a FeatureItem is just an
 * ordered pointer (`baseItemId`) into BASE's catalog. `BaseItemCache` is
 * a read-through cache kept warm by admin-authenticated actions (see its
 * own comment below for why that's also an auth-boundary decision, not
 * just a perf one), and `BaseOAuthToken` holds this shop's connected-app
 * credentials.
 */
const schema = a.schema({
  TemplateType: a.enum(["COLLECTION", "BRAND", "FEATURE"]),
  FeatureStatus: a.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]),

  // Structured AI-generated copy, kept as one JSON blob per feature so
  // individual sections (headline / intro / color variation copy / CTA…)
  // can be regenerated independently without a schema migration each time
  // the copy sections evolve. Shape (informal, enforced in lib/ai/types.ts):
  //   {
  //     headline: string
  //     intro: string
  //     productGroupNotes: string        // 商品群の特徴
  //     differenceNotes: string          // 商品同士の違い
  //     colorVariationNotes?: string      // カラー・仕様紹介
  //     stylingSuggestion: string        // コーディネート提案
  //     ctaText: string
  //   }
  Feature: a
    .model({
      title: a.string().required(),
      slug: a.string().required(),
      status: a.ref("FeatureStatus").required(),
      templateType: a.ref("TemplateType").required(),
      content: a.json(),
      seoTitle: a.string(),
      seoDescription: a.string(),
      heroBaseItemId: a.string(), // which selected item's image anchors the HERO
      publishedAt: a.datetime(),
      archivedAt: a.datetime(),
      items: a.hasMany("FeatureItem", "featureId"),
    })
    .secondaryIndexes((index) => [index("slug")])
    .authorization((allow) => [
      allow.group("Admins"),
      // Public visitors only ever need read access, and only for pages the
      // admin explicitly published. The public route (app/features/[slug])
      // enforces `status === "PUBLISHED"` in its query — Amplify Data does
      // not support row-level conditions on a public API-key rule, so this
      // is a deliberate application-layer check, not a data-layer one.
      allow.publicApiKey().to(["read"]),
    ]),

  FeatureItem: a
    .model({
      featureId: a.id().required(),
      feature: a.belongsTo("Feature", "featureId"),
      baseItemId: a.string().required(),
      sortOrder: a.integer().required(),
      isVisible: a.boolean().default(true),
    })
    .authorization((allow) => [
      allow.group("Admins"),
      allow.publicApiKey().to(["read"]),
    ]),

  // Read-through cache of BASE product data. Written only by admin-authenticated
  // code paths (search/generate/edit all fetch live BASE data already —
  // see lib/features/baseSync.ts) and read by the PUBLIC feature page. This
  // is deliberate, not just a perf optimization: it means the public route
  // never needs a BASE access token, so that credential never has to be
  // reachable from an unauthenticated request. A dedicated periodic sync
  // job (Phase 2) can refresh this on a schedule instead of only on admin
  // touch, but the auth boundary this creates is Phase 1.
  BaseItemCache: a
    .model({
      baseItemId: a.string().required(),
      title: a.string(),
      price: a.integer(),
      stock: a.integer(),
      isPublished: a.boolean(),
      imageUrls: a.string().array(),
      itemUrl: a.string(),
      brand: a.string(),
      variationLabel: a.string(), // e.g. color name, only if BASE provides one
      cachedAt: a.datetime().required(),
    })
    .identifier(["baseItemId"])
    .authorization((allow) => [
      allow.group("Admins"),
      allow.publicApiKey().to(["read"]),
    ]),

  // BASE OAuth2 tokens for this shop's connected app. Admin-only, no
  // public rule at all — unlike the models above, this is a credential,
  // not display data. There is exactly one row (id: "singleton"). Written
  // by the OAuth callback route (has the connecting admin's session) and
  // refreshed by lib/base/oauth.ts, always from an admin-authenticated
  // request context (see BaseItemCache comment above for why that's true
  // of every caller of the BASE API client in this system).
  //
  // ## 2026-09-01: `ADMIN` を追加した理由（実機で発見した接続不能の原因）
  //
  // このアプリには**別々のCognitoグループ体系**が2つある —— Feature/BASE
  // 側の `Admins` と、在庫管理側の `ADMIN`/`EDITOR`/`VIEWER`（このファイル
  // 冒頭の設計メモ参照）。BASE接続の操作画面は在庫管理側の
  // /inventory/settings にあり `ADMIN` で守られている。
  //
  // 実測: このユーザープールの唯一の利用者は `ADMIN` にのみ所属し
  // `Admins` には入っていない。そのためOAuth認可自体は成功しているのに、
  // 戻ってきたtokenをこのモデルへ書く操作が AppSync に拒否され、
  // BaseOAuthTokenテーブルは0行のままだった（両テーブルをscanして確認）。
  // 画面が「連携完了」と表示していたのは、書き込み結果のerrorsを
  // 呼び出し側が見ていなかったため（lib/base/oauth.ts側で修正済み）。
  //
  // 操作する画面の門と、そこが書くデータの認可を一致させる。
  // `Admins` も残すのは、/admin 配下の特集ページ機能が同じtokenを
  // 読んでいるため（BASE認証をひとつだけ持つ、という方針の維持）。
  BaseOAuthToken: a
    .model({
      accessToken: a.string().required(),
      refreshToken: a.string().required(),
      expiresAt: a.datetime().required(),
      updatedAt: a.datetime().required(),
    })
    .authorization((allow) => [allow.group("Admins"), allow.group("ADMIN")]),

  // ─────────────────────────────────────────────────────────────────────
  // Inventory (BELLO在庫管理システム, Phase 2: data model only, no UI yet)
  //
  // Design rule (mirrors the Feature/BASE separation above, and the
  // MercariListing pattern from the separate mercari-shops-auto-listing
  // branch): Inventory is BELLO's single source of truth for product/
  // stock data. It carries no marketplace-specific fields — a future
  // Mercari Shops / BASE listing integration gets its own table
  // (e.g. InventoryMercariListing) that points back at `Inventory.id`
  // (the immutable inventory_id), never the other way around.
  //
  // Auth: every Inventory-area model is Cognito User Pool group auth
  // ONLY (ADMIN / EDITOR / VIEWER) — deliberately no `allow.publicApiKey()`
  // anywhere below, so none of this is reachable with the schema's
  // `defaultAuthorizationMode: "apiKey"`. Callers must pass
  // `authMode: "userPool"` explicitly (see `inventoryAuthMode` in
  // lib/amplify/dataClient.ts) or every call is rejected outright — this
  // is intentional defense in depth, not just relying on there being no
  // apiKey rule.
  // ─────────────────────────────────────────────────────────────────────

  CustomFieldType: a.enum(["TEXT", "TEXTAREA", "NUMBER", "SELECT", "DATE", "URL"]),

  // Phase C.5: an image is either a normal product photo or a
  // damage/condition photo — absent (legacy rows written before this
  // enum existed) means NORMAL, handled entirely in application code
  // (see lib/inventory/imageTypes.ts's normalizeImageRecord), never by a
  // schema default here — a GraphQL enum field can't default to one of
  // its own values for rows that predate the field's existence, it just
  // reads as null/undefined, which the app already treats as NORMAL.
  ImageType: a.enum(["NORMAL", "DAMAGE"]),

  // BELLO画像自動加工システム §11.3: Image状態遷移。UNPROCESSED(初期)→
  // QUEUED(ProcessingJob作成済み)→PROCESSING(worker実行中)→READY(採用版
  // あり)。例外系はNEEDS_REVIEW(低confidenceで自動READYにしない、§17
  // 品質ゲート)/FAILED(処理失敗、RAW等は削除しない)/REPROCESSING(1枚
  // 単位の再加工中、§12)/SUPERSEDED(旧バージョン、rollbackで復活可能)。
  ImageProcessingStatus: a.enum(["UNPROCESSED", "QUEUED", "PROCESSING", "READY", "NEEDS_REVIEW", "FAILED", "REPROCESSING", "SUPERSEDED"]),

  // §7 画像分類。自動分類モデルは今回未実装(§Phase 1 PoCが必要、実画像
  // 無しのためこのラウンドでは未着手 — SPEC_UNCONFIRMED)なので、現状は
  // 常に手動割り当て専用(classificationConfidenceは常にnull)。
  ImageClassification: a.enum(["TOP", "FULL", "DETAIL", "DAMAGE", "LABEL"]),

  // §6 BELLO全体トップ画像標準の2択。
  ImageAspectRatio: a.enum(["SQUARE_1_1", "LANDSCAPE_3_2"]),

  // Named custom type (not a model — no table of its own) for the images
  // embedded on Inventory. Images are always read/written together with
  // their parent Inventory record and never queried independently, so an
  // embedded list keeps this to one DynamoDB item instead of a second
  // table + relation just to hold a handful of S3 keys.
  //
  // `type`/`isPrimary` (Phase C.5) replace the old implicit "index 0 in
  // the array = main image" convention with an explicit one, while
  // staying backward compatible with every row written before they
  // existed: both are optional, so an old image object simply has
  // type: null / isPrimary: null on read. lib/inventory/imageTypes.ts's
  // normalizeImageRecord/resolveTopImage are the ONE place that turns
  // that into "NORMAL, and the top image is whichever NORMAL image has
  // isPrimary — or if none do (every existing record today), the first
  // NORMAL image by sortOrder" — every reader (list, detail, edit,
  // duplicate) goes through those functions rather than re-deriving this
  // logic, so there's exactly one definition of "top image" in the app.
  //
  // Deliberately still ONE field/array (not a second `damageImages`
  // list) — this is what the spec's own example shape
  // ({storageKey, type, isPrimary, sortOrder}) asks for, and it means
  // zero renaming of the existing `images` field or its resolvers;
  // `sortOrder` is scoped within each `type` group (a NORMAL image's
  // position among other NORMAL images), not a single global order
  // across both — the client keeps normal/damage as two separate edited
  // lists and only flattens them into this one array at submit time
  // (see app/actions/inventory.ts's resolveImages).
  //
  // Extending this further later (original vs. processed image,
  // processing status/provider/timestamp for a future Adobe-API-backed
  // auto-correction pipeline — spec §6) is additive: more optional
  // fields on this same customType, no migration, exactly like this
  // Phase's own addition of type/isPrimary.
  InventoryImage: a.customType({
    storageKey: a.string().required(), // S3 key under the `inventory/` prefix — see amplify/storage/resource.ts
    sortOrder: a.integer().required(),
    type: a.ref("ImageType"), // optional — absent on legacy rows, see comment above
    isPrimary: a.boolean(), // optional — meaningful only for a NORMAL image; see resolveTopImage
    // ZAICO sync (added alongside Inventory.sourceSystem/sourceInventoryId
    // below): which one NORMAL image, if any, is "the ZAICO image" — the
    // sync must be able to tell that image apart from every other
    // BELLO-added NORMAL/DAMAGE photo so it only ever replaces that one
    // slot, never touching the rest (spec: 同期でBELLO追加画像を削除しな
    // い). `sourceUrl` is ZAICO's `item_image.url` at the time this
    // object was imported — compared against the current sync's URL so
    // an unchanged ZAICO photo is never re-downloaded/re-uploaded (spec:
    // 画像が変わっていなければ再アップロード不要). Both optional, so
    // every image written before this Phase (sync or not) simply reads
    // as sourceSystem: null — normalizeImageRecord treats that as "not
    // ZAICO's", exactly the right default.
    sourceSystem: a.string(),
    sourceUrl: a.string(),
    // BELLO統合改修 master指示書 Phase B(画像パフォーマンス): 一覧表示
    // 専用の縮小版オブジェクトのS3キー。`storageKey`(常にオリジナル
    // 解像度)とは別物 — 一覧のサムネイル表示だけがこちらを使い、詳細
    // 画面/ギャラリー/編集画面のプレビューは引き続き`storageKey`(オリ
    // ジナル)を使う(「詳細画面は高解像度のまま」という明示的な制約)。
    // 生成できなかった/まだ生成していない画像はnull — lib/inventory/
    // imageTypes.tsのeffectiveListThumbnailKeyがその場合`storageKey`
    // (オリジナル)へフォールバックするので、既存の全レコード・生成に
    // 失敗した画像も表示自体は壊れない(劣化するのは速度だけ)。生成は
    // lib/inventory/thumbnail.ts(sharp)が、新規アップロード時
    // (ZAICO同期・手動アップロードとも)にオリジナルと同時に一度だけ
    // 行う — 既存画像への遡及生成はlib/inventory/thumbnailBackfill.ts
    // が別途、ADMINが設定画面から任意のタイミングで走らせるバックフィ
    // ルとして行う。
    thumbnailKey: a.string(),
    // ─────────────────────────────────────────────────────────────────
    // BELLO画像自動加工システム(2026-08-30指示書)— このcustomTypeへは
    // originalHashだけを足す。処理結果(status/classification/採用
    // version/processedKey/webKey/confidence等)はあえてここへ
    // 二重化(denormalize)しない — バックグラウンドworker Lambdaが
    // Inventory.imagesという配列フィールドを安全に部分更新する手段が
    // 無い(DynamoDBのUpdateExpressionは配列要素をインデックスでしか
    // 更新できず、ブラウザ側の同時編集で配列順が変わるとインデックスが
    // ずれる実害がある)ため、書き込みは全て独立行のImageProcessingVersion
    // (このファイル下方)へ行い、そちらのGSI(imageStorageKey)で引く設計
    // にした——pricing-schedulerで確立した「GSIを持つ配列/オブジェクト
    // への部分更新は危険、独立テーブルへのUPDATE(GSIキー属性に触れない
    // 形)は安全」という原則を、今回は「そもそも配列を書き込み対象にし
    // ない」形でさらに徹底したもの。originalHashだけは例外——アップ
    // ロード時に一度書くだけで、その後workerもUIも書き換えないため
    // 安全(§11.4冪等性のキー計算に使う)。
    originalHash: a.string(),
    // §7 画像分類。type(NORMAL/DAMAGE)より細かい、加工の強さを決める
    // ための編集可能メタデータ(isPrimaryと同じ位置づけ — ユーザーが
    // 画像編集画面から設定する入力であり、workerが書き込む出力ではない
    // ため、Inventory.images配列への通常の保存経路(resolveImages、既存
    // のtype/isPrimaryと全く同じ書き込み方)で安全に扱える)。未設定は
    // null — lib/imageProcessing/jobService.tsのdefaultClassificationが
    // 「isPrimaryなNORMAL画像はTOP、それ以外のNORMALはFULL、DAMAGE画像
    // はDAMAGE」という既定値へ補完する。自動分類モデルは未実装(types.ts
    // のコメント参照)なのでconfidenceは持たない。
    classification: a.ref("ImageClassification"),
  }),

  // Category / Location masters below are intentionally flat (`parentId`
  // is a plain string field with a secondaryIndex, not a formal
  // self-referential belongsTo/hasMany relation). Amplify Gen2
  // self-referencing model relations are workable but add real
  // complexity for no Phase 2 benefit — nothing yet needs GraphQL to
  // resolve nested parent/child objects; "list children of X" is a
  // straightforward `parentId`-indexed query. If a future phase needs
  // nested traversal, this can still grow into a real relation without
  // a breaking schema change (adding a relation alongside an existing
  // scalar FK is additive).
  Category: a
    .model({
      name: a.string().required(),
      parentId: a.string(), // another Category's id, or absent for a top-level category
      sortOrder: a.integer().default(0),
      isActive: a.boolean().default(true),
    })
    .secondaryIndexes((index) => [index("parentId")])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read"]),
      allow.group("VIEWER").to(["read"]),
    ]),

  Location: a
    .model({
      name: a.string().required(),
      parentId: a.string(), // another Location's id (拠点 → 保管場所), or absent for a top-level location
      sortOrder: a.integer().default(0),
      isActive: a.boolean().default(true),
    })
    .secondaryIndexes((index) => [index("parentId")])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read"]),
      allow.group("VIEWER").to(["read"]),
    ]),

  // 単位マスタ(夜間開発指示書 §10)。Category/Locationと違い、
  // Inventory.unitはこのモデルのidを指す外部キーではなく、従来通りの
  // 自由文字列のまま(既存レコード・既存の新規登録/編集フォームを一切
  // 壊さないための設計判断) — このモデルは新規登録/編集フォームの
  // 単位入力欄が候補として提示する「よく使う単位名」の一覧に過ぎな
  // い。詳細はlib/inventory/masters.tsのファイル冒頭コメント参照。
  UnitMaster: a
    .model({
      name: a.string().required(),
      sortOrder: a.integer().default(0),
      isActive: a.boolean().default(true),
    })
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read"]),
      allow.group("VIEWER").to(["read"]),
    ]),

  StatusMaster: a
    .model({
      code: a.string().required(),
      label: a.string().required(),
      sortOrder: a.integer().default(0),
      isActive: a.boolean().default(true),
    })
    .secondaryIndexes((index) => [index("code")])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read"]),
      allow.group("VIEWER").to(["read"]),
    ]),

  // Admin-defined extra fields (ZAICOの「追加項目」相当). Only the field
  // *definitions* live here; the actual values for each Inventory item
  // live in `Inventory.customFields` (AWSJSON), keyed by `fieldKey`. This
  // is what lets an admin add a new field without a schema/DB migration.
  CustomFieldDefinition: a
    .model({
      fieldKey: a.string().required(), // key used inside Inventory.customFields, e.g. "material"
      label: a.string().required(),
      fieldType: a.ref("CustomFieldType").required(),
      required: a.boolean().default(false),
      sortOrder: a.integer().default(0),
      options: a.string().array(), // choices, only meaningful when fieldType === "SELECT"
      isActive: a.boolean().default(true),
    })
    .secondaryIndexes((index) => [index("fieldKey")])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read"]),
      allow.group("VIEWER").to(["read"]),
    ]),

  // The core record. `id` (auto-generated, immutable) IS `inventory_id` —
  // the internal identifier referenced by the spec's basic design
  // principle (§4): distinct from `sku`, which is the human-facing,
  // editable, duplicate-checked code BELLO staff actually work with.
  Inventory: a
    .model({
      sku: a.string().required(), // displayed in the UI as "在庫ID" (Phase C) — the field itself, its auto-numbering, and its uniqueness role are unchanged
      name: a.string().required(),
      categoryId: a.string(), // → Category.id, application-level reference (see note above)
      statusId: a.string(), // → StatusMaster.id
      locationId: a.string(), // → Location.id
      quantity: a.integer().default(0),
      unit: a.string(),
      purchasePrice: a.integer(), // 仕入単価 / 仕入・古物台帳の「購入価格」, JPY
      salePrice: a.integer(), // 販売価格（成約後の実売価格）, JPY — distinct from plannedSalePrice below
      note: a.string(),
      images: a.ref("InventoryImage").array(),
      customFields: a.json(), // { [fieldKey: string]: string | number | null }, shape governed by CustomFieldDefinition
      createdBy: a.string(),
      updatedBy: a.string(),
      // Soft delete (spec §15) — deliberately no hard-delete field. A
      // "deleted" item is just one where deletedAt is set; the normal
      // list screen filters `deletedAt` absent, the trash screen filters
      // it present. This sparse pattern is why `deletedAt` gets its own
      // secondaryIndex below instead of a redundant boolean flag.
      deletedAt: a.datetime(),
      deletedBy: a.string(),

      // ───────────────────────────────────────────────────────────────
      // Phase C: business fields BELLO actually needs, added as plain
      // optional scalars (every one below is unset/nullable — no
      // `.required()`) so every existing Inventory record stays valid
      // and readable exactly as before with no migration step. Naming
      // is deliberately English camelCase (see lib/inventory/
      // extendedFields.ts's own comment) so a future CSV/ZAICO import
      // maps one column to one field name directly, rather than a
      // Japanese UI label needing a separate translation table. Which
      // of the roughly 40 requested fields became a column here versus
      // a CustomFieldDefinition entry is explained in
      // lib/inventory/extendedFields.ts and lib/inventory/
      // customFieldSeed.ts respectively — the short version: anything
      // used for search/filter/sort, or structurally important for
      // sales/仕入台帳 record-keeping and future CSV export, is a real
      // column; genuinely low-frequency furniture-spec detail is a
      // CustomField instead.
      // ───────────────────────────────────────────────────────────────

      // 基本情報
      barcode: a.string(), // QRコード・バーコードの値

      // 販売情報
      plannedSalePrice: a.integer(), // ☆販売予定価格（送料別）
      firstMarkdownPrice: a.string(), // 1回目値下げ金額（30日）— spec: 現時点では文字列で可
      secondMarkdownPrice: a.string(), // 2回目値下げ金額（60日）
      thirdMarkdownPrice: a.string(), // 3回目値下げ金額（90日）
      saleStartDate: a.date(), // 販売開始日
      saleEndDate: a.date(), // 販売終了日
      market: a.string(), // 市場（メルカリShops / BASE 等の販売先）
      externalProductId: a.string(), // 商品ID（販売先サイト上のID）
      saleCommission: a.integer(), // 販売手数料
      listingNotes: a.string(), // <<出品情報>>（複数行）

      // コンディション — spec: 評価は現時点で単純なselectではなく複数行テキスト
      conditionRating: a.string(), // コンディション評価（複数行テキスト）
      damageNotes: a.string(), // 傷汚れ箇所等メモ（複数行）

      // サイズ・商品仕様 — spec: 現時点では文字列入力で可
      width: a.string(), // 幅（cm）
      depth: a.string(), // 奥行（cm）
      height: a.string(), // 高さ（cm）
      overallLength: a.string(), // 全長（cm）
      lengthAdjustable: a.string(), // 全長調節可否 — plain string, not an enum: UI renders it as a <select> with a small hardcoded option list (未設定/可/不可, see extendedFields.ts) that can grow later without a schema change
      mountType: a.string(), // 取付タイプ — options not finalized yet (spec); plain text input for now, same field would back a <select> once they are

      // 仕入・古物台帳（古物営業法の帳簿記載事項に相当）— structured
      // fields, not CustomField, since this is a compliance record that
      // needs to stay reliably exportable/queryable. purchasePrice above
      // doubles as this ledger's「購入価格」— not duplicated as a second
      // field. 古物の特徴 is the one exception, seeded as a
      // CustomFieldDefinition instead (see customFieldSeed.ts) since
      // it's a free-text description, not a structured ledger value.
      usedGoodsItemType: a.string(), // 品目
      transactionDate: a.date(), // 取引の年月日
      purchaseQuantity: a.integer(), // 数量（仕入台帳） — kept distinct from Inventory.quantity: a purchase-lot quantity is not always the same as current stock quantity
      transactionType: a.string(), // 取引区分 — options not finalized yet; plain text for now, same reasoning as mountType
      identityVerificationMethod: a.string(), // 取引相手の真偽確認のためにとった措置の区分および方法
      counterpartyName: a.string(), // 相手氏名
      counterpartyOccupation: a.string(), // 職業 — options not finalized yet; plain text for now
      counterpartyAddress: a.string(), // 住所
      shippingCost: a.integer(), // 送料
      dailyPurchaseTotal: a.integer(), // その日の仕入れ合計金額（他商品含む）

      // 管理メモ
      adminMemo: a.string(), // 管理メモ（複数行）

      // Migration metadata for a future ZAICO (or other system) import —
      // not written or read by any UI yet (spec: "本格的なZAICO移行処理
      // はまだ実装しない"), just reserved so that work doesn't need
      // another schema change to get started.
      sourceSystem: a.string(),
      /**
       * 前回のZAICO同期が「ZAICOから渡された値」を項目ごとに畳んだもの
       * (JSON文字列)。2026-09-02 追加。
       *
       * 人が変更した値をZAICO同期が差し戻す事故が実データで確認された
       * ため、3-way merge の基準として持つ:
       *
       *   BELLOの現在値 === 前回のZAICO値  → 誰も触っていない → 更新可
       *   BELLOの現在値 !== 前回のZAICO値  → 人が変えた       → 方針に従う
       *
       * ここに入るのは**ZAICOが何と言ってきたか**であって、BELLOが何に
       * なったかではない。取り違えると、人が変更した項目が次回
       * 「前回値と同じ」に見えて2回目の同期で上書きされる。
       *
       * 未記録(null)は「誰が入れた値か分からない」を意味し、保護対象の
       * 項目は上書きせずスナップショットだけを記録する(安全側)。
       */
      zaicoSnapshotJson: a.string(),
      sourceInventoryId: a.string(),

      // 第六ラウンド§19-20(P0-5): 一覧のupdatedAt DESCソート済み
      // server-side cursor paginationを実現するための、定数パーティション
      // キー+ソートキーGSI(DynamoDBで「テーブル全体をある属性でソート
      // したい」場合の標準パターン)。
      //
      // 【なぜAmplify自動付与のupdatedAtを直接使わないか】このリポジトリの
      // AIUsageLogモデルの既存コメントが記録する通り、Amplify Dataの
      // 自動付与タイムスタンプ(createdAt/updatedAt)はsecondaryIndexesの
      // sortKeysに指定できない(synth時に実際にエラーで確認済み——明示的
      // なmodelフィールドしか使えない)。そのため、既存の自動updatedAtと
      // 意味的に等価な明示フィールド`listUpdatedAt`をこのモデルへ追加し、
      // create/update双方の書き込み経路で必ず`new Date().toISOString()`
      // を設定する(全書き込み経路のリストと実装はdocs/
      // inventory-cursor-pagination-20260830.md参照)。
      //
      // `listingPartition`は常に固定値"ACTIVE"を入れる(deletedAtによる
      // 論理削除は現状どの書き込み経路にも実装されておらず——
      // Inventory.delete()による物理削除のみ実在する、lib/inventory/
      // queries.tsのfetchAllInventoryRecordsコメント参照——物理削除
      // された行はGSIからもテーブル本体からも自動的に消える)。既存
      // データへの移行(lib/inventory/listingPartitionBackfill.ts参照)が
      // 完了するまでは、この属性を持たない既存行はこのGSIに現れない
      // ——だからこそlistInventory本体はこのラウンドではまだこのGSI
      // 経由の関数へ切り替えていない(同docsに安全な切り替え手順を明記)。
      listingPartition: a.string(),
      listUpdatedAt: a.datetime(),
    })
    .secondaryIndexes((index) => [
      index("sku"), // search + pre-create duplicate-check (see §6 below on exact guarantees)
      index("categoryId"),
      index("statusId"),
      index("locationId"),
      index("deletedAt"),
      index("listingPartition").sortKeys(["listUpdatedAt"]),
    ])
    .authorization((allow) => [
      allow.group("ADMIN"), // full CRUD, including hard delete (完全削除)
      allow.group("EDITOR").to(["read", "create", "update"]), // no hard delete — logical delete is just an update setting deletedAt
      allow.group("VIEWER").to(["read"]),
    ]),

  // Audit trail (spec §16). Kept as its own table — unlike everything
  // else here, this grows without bound and is never edited in place, so
  // it doesn't belong embedded on Inventory. `inventoryId` + `changedAt`
  // as a composite index supports "history for this item, in order".
  InventoryHistory: a
    .model({
      inventoryId: a.string().required(),
      changedAt: a.datetime().required(),
      changedBy: a.string(),
      fieldName: a.string().required(),
      oldValue: a.string(),
      newValue: a.string(),
    })
    .secondaryIndexes((index) => [index("inventoryId").sortKeys(["changedAt"])])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read", "create"]),
      allow.group("VIEWER").to(["read"]), // VIEWER can already read every current field via Inventory itself, so no reason to hide its history
    ]),

  // Custom mutation backing SKU auto-numbering (spec §6 revision — SKU is
  // no longer user-entered). Same ADMIN/EDITOR authorization as creating
  // an Inventory itself; VIEWER cannot call this any more than it can
  // create Inventory records. See amplify/functions/generate-sku for why
  // this needs to be a Lambda (atomic DynamoDB counter) rather than
  // application-level logic, and amplify/backend.ts for the counter table
  // this function reads/writes.
  generateInventorySku: a
    .mutation()
    .returns(a.string())
    .authorization((allow) => [allow.group("ADMIN"), allow.group("EDITOR")])
    .handler(a.handler.function(generateSku)),

  // ─────────────────────────────────────────────────────────────────────
  // ZAICO background full sync (BELLO統合改修 master指示書 Phase A).
  //
  // Orchestration note (root cause investigation, not a guess): the
  // originally-designed architecture used a scheduled Amplify Function
  // (EventBridge-backed, via defineFunction's `schedule` option) that
  // would advance this job on its own, unattended, via
  // `allow.resource(fn)` model-level authorization (the officially
  // documented mechanism referenced by @aws-amplify/backend-function's
  // own getAmplifyDataClientConfig helper). This was implemented, then
  // found to fail at BOTH compile time ("Property 'resource' does not
  // exist on type 'BaseAllowModifier'") AND runtime ("allow.resource is
  // not a function") against @aws-amplify/data-schema@1.26.1 - the
  // latest version published as of this change (confirmed via `npm view
  // @aws-amplify/data-schema versions`, so this is not a stale-dependency
  // problem an upgrade would fix). The package's own source
  // (Authorization.mjs) confirms this directly: `// TODO: delete when we
  // make resource auth available at each level in the schema (model,
  // field)` - function-resource-based model/field authorization is
  // acknowledged-but-not-yet-shipped in Amplify Gen2 itself at this
  // point in time, not a mechanism this app is using incorrectly.
  //
  // Because of that confirmed gap, there is currently no supported way
  // for a bare Lambda to read/write Inventory/InventoryHistory/Category/
  // Location without either (a) a broad apiKey rule (rejected - would
  // reopen the public-API-key hole this schema deliberately never had
  // for Inventory data) or (b) hand-written raw DynamoDB calls against
  // Amplify's internal, undocumented table item shape (rejected as
  // unacceptably risky to author correctly without a live table to
  // verify against). The scheduled-Lambda approach is therefore not
  // shipped in this round - see docs/aws-test-environment.md for the
  // full writeup and what unblocks it (either a future Amplify Gen2
  // release that finishes this TODO, or a deliberate, separately-
  // reviewed decision to accept one of the two rejected options above).
  //
  // What IS shipped instead: this same ZaicoSyncJob checkpoint/lock
  // model, advanced by ADMIN-triggered Server Actions
  // (lib/inventory/zaicoBackgroundSync.ts) that reuse the
  // already-AWS-verified serverDataClient path (getServerSyncPort from
  // zaicoSyncPorts.ts) - each "advance" call processes one bounded ZAICO
  // page (not the whole catalog) and returns, so no single HTTP request
  // ever runs long enough to hit the ~3 minute timeout the master
  // instructions identified as the original problem. The settings UI
  // drives repeated "advance" calls while a run is in progress (a
  // background job in the sense of "resumable, checkpointed, never
  // blocks on the whole catalog in one request" - not yet in the sense
  // of "keeps running with no browser tab open", which needs the gap
  // above closed first).
  //
  // Exactly ONE row exists (id: ZAICO_SYNC_JOB_SINGLETON_ID, see
  // lib/inventory/zaicoBackgroundSync.ts) — "the current/most recent
  // background full-sync job". A single well-known id gives concurrency
  // control for free: starting a new run is a conditional update against
  // this one row (refuses if it is already PENDING/RUNNING) rather than
  // needing a separate lock table.
  //
  // `seenSourceIds` (BELLO統合改修 master指示書 Phase A: 「missing detection
  // safety」) accumulates every ZAICO sourceInventoryId actually observed
  // so far in the CURRENT run — compared, only once the run reaches
  // COMPLETED (never on a partial/cancelled run, so an interrupted sync
  // can never misreport real records as missing), against every BELLO
  // record with sourceSystem="ZAICO" to populate `missingSourceIds`. This
  // is reporting only — nothing is ever auto-deleted from BELLO.
  // ─────────────────────────────────────────────────────────────────────
  ZaicoSyncStatus: a.enum(["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]),

  /**
   * 同期の走らせ方。
   *
   *   DELTA … 通常運用。前回の成功時刻以降に ZAICO 側で作成/更新された
   *           ものだけを処理する。
   *   FULL  … 管理者が明示的に実行したときだけ。全件を処理する。
   *
   * ZAICO API は「更新日時以降だけ返す」条件指定に**対応していない**
   * (2026-09-02 実測。updated_at_since / since / updated_at_gteq など
   *  8種のパラメータと未来日時を試したが、いずれも応答が変わらず常に
   *  1,000件を返した)。そのため取得の往復自体は減らせない。
   *  減らせるのは1件ごとの処理 —— 既存在庫の照合・マージ・書き込み・
   *  画像取り込み・履歴記録で、同期時間の大半はここ。
   */
  ZaicoSyncMode: a.enum(["DELTA", "FULL"]),

  ZaicoSyncJob: a
    .model({
      status: a.ref("ZaicoSyncStatus").required(),
      lastPage: a.integer().default(0), // next ZAICO page to fetch (checkpoint)
      totalProcessed: a.integer().default(0),
      created: a.integer().default(0),
      updated: a.integer().default(0),
      unchanged: a.integer().default(0),
      failed: a.integer().default(0),
      imageImported: a.integer().default(0),
      seenSourceIds: a.json(), // string[] accumulated across the run — see comment above
      missingSourceIds: a.string().array(), // computed once COMPLETED only
      startedAt: a.datetime(),
      updatedAt: a.datetime(), // last checkpoint write, not a schema-managed timestamp
      finishedAt: a.datetime(),
      lastError: a.string(),
      triggeredBy: a.string(),
      // ─────────────────────────────────────────────────────────────
      // BELLO統合業務OS 第五ラウンド §4(P0-A): ブラウザ非依存の完全
      // Background Job化に必要なlease/heartbeat/retry。この4フィールド
      // により、ブラウザ手動advance(zaicoBackgroundSync.ts)と
      // amplify/functions/zaico-sync-worker/(スケジュールLambda)の
      // 両方が同じジョブ行を安全に共有できる——どちらか一方が
      // leaseOwnerを保持している間は、もう一方は同じページを二重処理
      // しない(claimLease系のConditionExpressionで強制)。
      // ── 差分同期 ────────────────────────────────────────────────
      //
      // lastSuccessfulSyncAt は**実行開始時にリセットしない**。
      // COMPLETED になったときだけ進める —— 途中でエラー・タイムアウト・
      // 中断が起きた回で進めてしまうと、その回に処理できなかった分を
      // 次回が「前回以降ではない」と判断して永久に取りこぼす。
      //
      // 記録するのは「その回の開始時刻」であって完了時刻ではない。
      // 実行中に ZAICO 側で更新されたものを次回が拾えるようにするため。
      lastSuccessfulSyncAt: a.datetime(),
      mode: a.ref("ZaicoSyncMode"), // この回の走らせ方。省略時(既存行)は FULL 相当として扱う
      syncSince: a.datetime(), // この回で実際に使った切り取り時刻(報告用。FULL では null)
      skippedByDelta: a.integer().default(0), // 「前回以降に変わっていない」で処理を省いた件数
      leaseOwner: a.string(), // 例: "lambda:<requestId>" / "browser:<sessionToken先頭8文字>"。null=誰も保持していない
      leaseExpiresAt: a.datetime(), // この時刻を過ぎたleaseは失効扱い——保持者がクラッシュしても永久にブロックしない
      retryCount: a.integer().default(0), // 直近のadvance/pageで失敗した回数。上限到達でFAILEDへ(DLQ相当)
      lastHeartbeatAt: a.datetime(), // 実行中であることを示す生存確認。UIの「実行中だが最後の更新から時間が経っている」検知にも使える
    })
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read"]), // visibility only — starting/cancelling/advancing a background sync is an ADMIN action, same boundary as the synchronous sync Server Actions
    ]),

  // ─────────────────────────────────────────────────────────────────────
  // 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §11: 実データで
  // 確認された「同一ZAICO在庫ID(例: 50666071)がBELLO側で複数Inventory
  // に紐付いている」重大不具合への根本対応。
  //
  // 根本原因(実装コードを読んで特定、推測ではない):
  // `lib/inventory/zaicoSyncPorts.ts`の`findExistingBySourceId`は
  // 「そのsourceInventoryIdを持つ既存Inventoryがあるか」を
  // `Inventory.list({filter: {sourceSystem, sourceInventoryId}})`という
  // **nextTokenページングの無い単発の`.list()`呼び出し**で判定していた
  // ——sourceSystem/sourceInventoryIdはInventoryのGSIに含まれておらず
  // (secondaryIndexesに無い)、この呼び出しは実質DynamoDB Scan+
  // FilterExpressionであり、単発呼び出しは「テーブル全体」ではなく
  // DynamoDBが1回のレスポンスで返せる範囲(≈1MB分の生item)しか走査
  // しない。Inventoryが増えるほど、目的の行がこの1回の走査範囲外に
  // 落ちる確率が上がり、「既存が見つからない」と誤判定→新規重複作成、
  // という不具合を構造的に埋め込んでいた(このリポジトリの他の箇所
  // ——`fetchAllInventoryRecords`/`serverFetchAllZaicoManaged`等——は
  // 同じ理由から必ずnextTokenループで全件走査しており、この関数だけが
  // 例外的にループを欠いていた)。
  //
  // 併せて指示書§11.7が要求する「DB層でのcreate二重防止」
  // (アプリ側の「検索→無ければcreate」だけでは競合時に二重create
  // し得る)にも対応する必要がある。
  //
  // この`ZaicoSourceLink`モデル1つで両方を解決する:
  //   1. `id`をsourceSystem+sourceInventoryIdから決定的に組み立てる
  //      (例: "ZAICO#50666071")ことで、`.get({id})`という**主キー直接
  //      取得**(スキャン不要、常に完全・即時)がexisting判定の一次
  //      手段になる——上記のスキャン欠落バグを構造的に再発不能にする。
  //   2. Amplifyが生成する`create`ミューテーションは(AppSyncの標準
  //      挙動として)対象`id`に対し`attribute_not_exists`相当の条件付き
  //      書き込みを行う——同じ`id`で2回目の`create`は必ず失敗する。
  //      これを「同じsourceInventoryIdの二重claim」を防ぐ排他ロックと
  //      して使う(`lib/inventory/zaicoSyncPorts.ts`の
  //      `claimSourceLink`参照)——新規のDynamoDB SDK直接操作は導入せず、
  //      既存の`ZaicoSyncJob`が単一行id(`ZAICO_SYNC_JOB_SINGLETON_ID`)
  //      で既に使っているのと全く同じ「決定的なcustom id」パターンの
  //      応用に過ぎない。
  //
  // `inventoryId`は他の箇所(ListingDraft/ChannelListing等)と同じ
  // フラットなID参照(belongsToリレーションではない)。
  // ─────────────────────────────────────────────────────────────────────
  ZaicoSourceLink: a
    .model({
      sourceSystem: a.string().required(), // 現状は"ZAICO"のみ。将来別ソースが増えても`id`の名前空間が衝突しないよう明示的に持つ
      sourceInventoryId: a.string().required(),
      inventoryId: a.string().required(), // → Inventory.id
    })
    .secondaryIndexes((index) => [index("inventoryId")]) // 逆引き(重複統合時、あるInventoryが持つlinkを消す/付け替える用途)
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read", "create", "update", "delete"]), // ZAICO同期の実行権限はADMIN限定(app/actions/zaicoSync.ts)だが、このモデル自体はInventory本体と同じ編集権限境界にしておく(将来の実行権限緩和に追従しやすくするため)
      allow.group("VIEWER").to(["read"]),
    ]),

  // ─────────────────────────────────────────────────────────────────────
  // BELLO統合改修 master指示書 Phase D: EC Listing / Mercari Shops連携。
  //
  // 絶対要件(spec): Inventory MasterへEC出品専用フィールドを一切混在
  // させない。EC出品データはInventoryとは別のモデルへ完全に分離する
  // — 以下のListingDraft/ChannelListingは、どちらも独立したモデルで
  // あり、Inventory model自体には1フィールドも追加していない
  // (inventoryIdによる紐付けのみ、Category/Locationの親子関係と同じ
  // 「正式なbelongsTo relationではなくフラットなID参照」方式 — Phase 2
  // 時点でこのアプリが既に採用しているパターンを踏襲)。
  //
  // spec指定の5概念(Inventory / Common Listing Draft / Channel Listing
  // / Channel Override / External Listing Status)を、モデル数を最小限
  // に保ちながら以下2モデルへ実装している(spec自身の「schema追加は
  // 最小限に」との指示、およびこのアプリ全体の「今の規模に対して過剰
  // 設計しない」という一貫した設計判断に合わせた、意図的な単純化):
  //   - Inventory              → 既存Inventoryモデル(無変更)
  //   - Common Listing Draft   → ListingDraft(チャネルに依存しない
  //                              共通の出品下書き — タイトル/説明文/
  //                              価格/コンディション/画像。1つの
  //                              Inventoryにつき通常1件)
  //   - Channel Listing        → ChannelListingのchannel/status/
  //                              createdAt/updatedAtフィールド
  //   - Channel Override       → ChannelListingのoverrideTitle/
  //                              overrideDescription/overridePrice
  //                              (設定されていれば共通下書きの値より
  //                              優先される — チャネルごとに「ここだけ
  //                              違う」を表現する最小限の形。将来2つ目
  //                              以降のチャネルが実際に追加された時点
  //                              で、真に共有できない項目が増えれば、
  //                              このJSON/フィールド構成を見直せば良い)
  //   - External Listing Status → ChannelListingのstatus/
  //                              externalListingId/listingUrl/
  //                              listedAt/lastError
  // ChannelListingが「Channel Listing」「Channel Override」
  // 「External Listing Status」の3概念を1モデルに同居させているのは、
  // 現時点でチャネルがMercari Shops 1つしかなく、これら3つが常に
  // 1:1(1つのChannelListingの生涯にわたって1組)の関係にあるため —
  // 将来別チャネルが増えても、この1モデルに新しい行(channel="..."の
  // 別行)が増えるだけで、モデル自体の再設計は不要。
  //
  // READ ONLY境界(spec): 在庫マスタのユーザーによる作成・編集・削除は
  // 禁止のまま — ListingDraft/ChannelListingへの書き込みは
  // lib/listing/service.tsを通じてのみ行われ、そこはInventoryモデルへ
  // 一切書き込まない(在庫の書き込みはapp/actions/inventory.ts経由の
  // 既存の道だけ)。これはコード構造上の分離であり、このschema定義
  // 自体もそれを裏付ける — ListingDraft/ChannelListingのどちらも
  // Inventoryモデルのフィールドを一切変更しない、独立したモデル。
  // BELLO統合業務OS 第二次完全完遂指示(2026-08-30) §4: BASE
  // (thebase.in)を「別システムだから」という理由で対象外にしない —
  // BASEは商品作成(items/add)・商品編集(items/edit)を公式に提供する
  // 実在の書き込み可能なAPIであることをWebSearchで確認済み
  // (lib/listing/base/adapter.ts参照)。ChannelListing.channelへ
  // "BASE"を追加するだけで、既存のListingDraft/ChannelListing設計
  // (1つのInventory×複数チャネル)がそのまま両チャネルに対応する。
  ListingChannel: a.enum(["MERCARI_SHOPS", "BASE"]),

  ListingCondition: a.enum(["NEW", "LIKE_NEW", "NO_NOTABLE_DAMAGE", "SLIGHT_DAMAGE", "DAMAGE", "BAD"]), // lib/listing/condition.tsの6段階と1対1 — Mercariの実際のcondition enum値は lib/listing/mercari/mapper/condition.ts が変換する(BELLOの内部語彙とMercari APIの語彙を分離)

  /**
   * BELLO統合業務OS指示書(2026-08-30) §14: Listing Status State
   * Machine。以前は["DRAFT", "QUEUED", "LISTED", "FAILED"]の4値だけ
   * だったが、状態遷移(§21 再出品/§19 自動価格の安全条件等)を正しく
   * 表現するには不足していたため、指示書の12値へ拡張した。
   * state transitionはlib/listing/service.tsの中でのみ管理し、UIが
   * 直接自由にstatusを変更しない、という原則(§14)は既存のまま —
   * ChannelListing.statusへの書き込みはlib/listing/service.tsの数関数
   * (saveChannelOverride/listOnMercari)経由のみで、Server Action/UIから
   * status値を直接受け取って書き込む経路は無い。
   *
   * 現在の実装が実際に到達する状態(§109/§155「fake successにしない」
   * の原則どおり、遷移させる手段が無い状態を実装済みとは言わない):
   *   DRAFT(ChannelListing作成時) → PUBLISHING(出品API呼び出し直前)
   *   → ACTIVE(成功) または ERROR(失敗)。
   * NOT_PREPARED/READY/QUEUED/PAUSED/SOLD/ENDED/RELIST_PENDING/ARCHIVED
   * はスキーマ上の値として用意しているが、そこへ遷移させる具体的な
   * トリガー(§82一括操作のキュー、§128外部ステータス同期、§21実際の
   * 再出品API呼び出し等)はまだ実装していない — 完了報告で
   * LOCAL_IMPLEMENTED(スキーマ)とLOCAL_VERIFIED(実際に遷移する経路)
   * を明確に分けて報告する。
   */
  ListingStatus: a.enum([
    "NOT_PREPARED",
    "DRAFT",
    "READY",
    "QUEUED",
    "PUBLISHING",
    "ACTIVE",
    "PAUSED",
    "SOLD",
    "ENDED",
    "RELIST_PENDING",
    "ERROR",
    "ARCHIVED",
  ]),

  /** チャネルに依存しない共通の出品下書き — 1つのInventoryにつき0または1件。 */
  ListingDraft: a
    .model({
      inventoryId: a.string().required(), // FK — belongsTo relationではなくフラットなID参照(Category/Locationのparent-child関係と同じ設計判断)
      title: a.string().required(),
      description: a.string(),
      price: a.integer(),
      condition: a.ref("ListingCondition"),
      images: a.json(), // Inventory.images由来のstorageKeyを並び替えたもの([{storageKey, sortOrder}] 相当) — 出品用に画像を再アップロードすることはない、既存のInventory画像をそのまま参照する
      /**
       * 2026-09-04 EC出品改修 追加指示 §1: 配送方法("KAZAI" | "SAGAWA")。
       *
       * ── なぜ担当者が選ぶのか ────────────────────────────────
       *
       * どの商品を佐川で送るかは、寸法だけでは決まらない(形状・梱包の
       * しやすさ・数量・納期)。**サイズから自動で切り替えない**という
       * 指示なので、システムは推測せず、選ばれた方法に応じて説明文の
       * 「◎発送について」を切り替えるだけにする。
       *
       * ── なぜ ListingDraft に置くのか ────────────────────────
       *
       * 商品説明(description)と同じ「共通項目」で、チャネルごとに変わる
       * ものではない。ChannelListing へ置くと、Mercari用とBASE用で
       * 別々の配送方法を持ててしまい、同じ商品の説明文が食い違う。
       * ここに置けば、説明文を再生成しても選択が残る(下書きを読み直す
       * だけで前回の選択が手に入る)。
       *
       * 未設定(null)は「らくらく家財便」として扱う —— 既存の下書きは
       * すべて null なので、既定値をコード側(DEFAULT_LISTING_SHIPPING_METHOD)
       * で決め、マイグレーションを不要にする。
       */
      shippingMethod: a.string(),
      createdBy: a.string(),
      updatedBy: a.string(),
      deletedAt: a.datetime(), // ソフトデリート — Inventory本体と同じ規約
    })
    .secondaryIndexes((index) => [index("inventoryId")])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR"), // Inventory編集権限(canEditInventory)と同じ境界 — spec: 「Listing: create/edit allowed」
      allow.group("VIEWER").to(["read"]),
    ]),

  /** チャネル別の出品状態(Channel Listing + Channel Override + External Listing Statusを1モデルに統合 — 上のコメント参照)。1つのListingDraftにつき、チャネルごとに0または1件(重複防止はlib/listing/service.ts側でinventoryId+channelの事前存在チェックにより行う — DynamoDBに複合ユニーク制約は無いため)。 */
  ChannelListing: a
    .model({
      listingDraftId: a.string().required(),
      inventoryId: a.string().required(), // 非正規化 — READ ONLY境界チェック/一覧表示のためlistingDraftを経由せず直接引けるようにする
      channel: a.ref("ListingChannel").required(),
      categoryMapping: a.json(), // チャネル固有のカテゴリ情報(例: {mercariCategoryId, mercariCategoryName})
      overrideTitle: a.string(), // 設定されていればListingDraft.titleより優先
      overrideDescription: a.string(),
      overridePrice: a.integer(),
      status: a.ref("ListingStatus").required(),
      externalListingId: a.string(), // 例: MercariのProduct ID
      listingUrl: a.string(),
      // BELLO統合業務OS指示書(2026-08-30) §15: 出品開始日時の自動記録
      // — 単一のlistedAtフィールド(以前の形)では「初回出品はいつか」
      // と「直近の(再)出品はいつか」を区別できなかったため、3フィール
      // ドへ分離した(まだ実際のUIには表示していないフィールドなので、
      // 破壊的変更ではなく単純な置き換えとして扱った)。
      //   firstListedAt: 初回成功時刻のみ、以降は上書きしない
      //   lastListedAt : 直近の成功(初回 or 再出品)のたびに更新
      //   lastRelistedAt: 再出品が成功した時刻のみ(初回では設定しない)
      // すべてlib/listing/service.tsが出品API成功時にのみ設定する —
      // 失敗時に成功扱いの日時を書き込むことは無い(§144「外部成功前に
      // success icon禁止」と同じ考え方)。
      firstListedAt: a.datetime(),
      lastListedAt: a.datetime(),
      lastRelistedAt: a.datetime(),
      /** §21: 出品終了(売却以外の理由)。現時点でこの状態へ遷移させる具体的なトリガーは未実装 — スキーマのみ用意。 */
      endedAt: a.datetime(),
      /** §83: 売却記録用。Cross-channel sold protectionの実装(他チャネルの出品を自動停止する等)は今回のラウンドでは未着手 — スキーマのみ用意。 */
      soldAt: a.datetime(),
      lastError: a.string(),
      createdBy: a.string(),
      updatedBy: a.string(),

      // ───────────────────────────────────────────────────────────────
      // BELLO統合業務OS指示書(2026-08-30) §18: 商品別自動価格設定。
      // autoPricingEnabledの既定値はfalse(§161「本番自動実行は
      // default OFF」— 個別の商品ごとにADMIN/EDITORが明示的にONへ
      // 切り替えるまで、この商品は絶対に自動値下げされない)。
      // lib/listing/pricing.tsのevaluatePricingSafetyがこのフラグと
      // status/quantity等を突き合わせて安全条件を判定する(§19)。
      // 実際にMercariへ価格変更を送信するupdateProduct相当の呼び出し
      // は、そのGraphQL実Schemaがこのsandbox環境から確認できていない
      // ([UNVERIFIED])ため今回は未実装 — evaluatePricingSafetyが
      // 「今、値下げ実行して良いか」までを判定し、実際の外部API呼び出し
      // は明示的にBLOCKED_BY_EXTERNAL_SERVICEとして完了報告に記載する。
      // ───────────────────────────────────────────────────────────────
      autoPricingEnabled: a.boolean().default(false),
      pricingRuleId: a.string(), // → PricingRule.id
      originalPrice: a.integer(), // 初回出品時の価格(値下げの基準点)
      currentPrice: a.integer(), // 現在Mercari上で有効なはずの価格(BELLO側の認識 — 実際にMercari上と一致しているかはstatus sync未実装のため保証できない)
      floorPrice: a.integer(), // PricingRuleから計算された下限価格(lib/listing/pricing.tsのcalculateFloorPrice)
      markdownCount: a.integer().default(0),
      lastPriceChangeAt: a.datetime(),
      nextPriceActionAt: a.datetime(), // スケジューラがこの時刻以降にrunPricingCheckを呼ぶ(§22)。「スケジューラ自体は今回未実装」と書いていたのは陳腐化 — amplify/functions/pricing-schedulerが実装済みで、AWS上で毎時(cron(0 */1 * * ? *))稼働していることを実測確認済み。未実装なのはMercariへの実価格送信のみ(handler.tsの該当コメント参照)。
      automationHold: a.boolean().default(false), // ADMINが個別に一時停止したい場合の手動フラグ(autoPricingEnabledとは別 — こちらはルール自体を無効化せず一時停止するためのもの)
      lastAutomationResult: a.string(), // 直近のrunPricingCheck結果の要約(監査用、§85 Audit Log相当の最小実装)

      // ───────────────────────────────────────────────────────────────
      // BELLO統合業務OS指示書(2026-08-30) §67-68: 家財おまかせ便の
      // 送料見積り。shippingRank/calculatedShippingFeeはInventoryの
      // 寸法+選択した発送先都道府県からlib/shipping/service.tsの
      // calculateShippingEstimateが自動計算して書き込む(参考値)。
      // confirmedShippingFeeはADMIN/EDITORが実際の値を確認して手動で
      // 確定させた値(§68「calculated shippingとconfirmed shippingの
      // 区別」) — AI返信生成(lib/ai/ecCopy.ts §69)はconfirmedを優先し、
      // 無ければcalculatedを使い、どちらも無ければ送料に触れない。
      // ───────────────────────────────────────────────────────────────
      shippingRank: a.ref("ShippingRank"), // Inventoryの寸法から計算した直近のランク(発送先に依存しない)
      shippingDestinationPrefecture: a.string(), // 見積りに使った発送先(参考値 — 実際の購入者の住所とは限らない)
      calculatedShippingFee: a.integer(), // ShippingRateマスタからの自動見積り
      confirmedShippingFee: a.integer(), // 人が確認・確定した金額(AI返信等で優先的に使う確定値)
      shippingFeeUpdatedAt: a.datetime(),
    })
    .secondaryIndexes((index) => [index("inventoryId"), index("listingDraftId")])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR"),
      allow.group("VIEWER").to(["read"]),
    ]),

  // ─────────────────────────────────────────────────────────────────────
  // BELLO統合業務OS指示書(2026-08-30) §17: Pricing Rule Engine。
  // 値下げ日数・率はBELLO独自の経営ルールとして将来変わりうるため
  // hardcodeしない(§2.3の「価格を何日後に何%下げるかというBELLO独自の
  // 経営ルールが全く未定」という質問例そのもの) — ADMINが設定画面から
  // ルールを作成・編集できるようにする、という形でこの可変性に対応する。
  // ─────────────────────────────────────────────────────────────────────
  PricingMarkdownType: a.enum(["FIXED_AMOUNT", "PERCENTAGE"]),
  /** 下限価格の指定方法 — 固定額、または初回価格に対する割合。 */
  PricingFloorMode: a.enum(["FIXED_AMOUNT", "PERCENTAGE_OF_ORIGINAL"]),
  PricingActionAtFloor: a.enum(["KEEP", "PAUSE", "RELIST", "MANUAL_REVIEW"]),

  PricingRule: a
    .model({
      name: a.string().required(),
      enabled: a.boolean().default(false), // §161: ルール自体も既定は無効 — ChannelListing.autoPricingEnabledとの二重の安全弁
      channel: a.ref("ListingChannel").required(),
      startAfterDays: a.integer().required(), // 出品(firstListedAt)から何日後に最初の値下げを行うか
      intervalDays: a.integer().required(), // 以降何日おきに値下げを繰り返すか
      markdownType: a.ref("PricingMarkdownType").required(),
      markdownValue: a.integer().required(), // FIXED_AMOUNTなら円、PERCENTAGEなら%(1〜100)
      floorPriceMode: a.ref("PricingFloorMode").required(),
      floorPriceValue: a.integer().required(),
      maxExecutions: a.integer(), // 未設定なら無制限(floorPriceで自然に停止する)
      relistEnabled: a.boolean().default(false),
      relistAfterDays: a.integer(), // relistEnabled時のみ意味を持つ
      actionAtFloor: a.ref("PricingActionAtFloor").required(),
      createdBy: a.string(),
      updatedBy: a.string(),
    })
    .authorization((allow) => [
      allow.group("ADMIN"), // ルールの作成・編集はADMIN限定(価格戦略そのものの設定のため、EDITORの「Listing: create/edit allowed」より一段厳しい境界にする)
      allow.group("EDITOR").to(["read"]), // 個別ChannelListingへルールを割り当てる際、EDITORも選択肢一覧を読める必要がある
      allow.group("VIEWER").to(["read"]),
    ]),

  PriceHistoryActor: a.enum(["USER", "SYSTEM"]),

  /** §20: 「なぜこの価格になったか」を追跡可能にする価格変更履歴。実際にMercariへ反映される前(dry-run/評価のみ)の記録も含む — reasonフィールドで区別する。 */
  PriceHistory: a
    .model({
      channelListingId: a.string().required(),
      oldPrice: a.integer(),
      newPrice: a.integer().required(),
      reason: a.string().required(),
      ruleId: a.string(),
      actor: a.ref("PriceHistoryActor").required(),
      externalResult: a.string(), // 実際の外部API呼び出し結果(未実装の間は"NOT_IMPLEMENTED"等、正直な値を入れる — §157 fake success禁止)
      changedAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [index("channelListingId")])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read"]),
      allow.group("VIEWER").to(["read"]),
    ]),

  // ─────────────────────────────────────────────────────────────────────
  // BELLO統合業務OS指示書(2026-08-30) §38-50: Message core
  // (Conversation/Message)。対象チャネルはMercari Shops/Yahoo!オーク
  // ションストア/LINE公式アカウント/Email(§39) — ListingChannel
  // (現状Mercari Shopsのみ)とは独立したenumにしてある。将来チャネルが
  // 増えても、出品(Listing)とメッセージ(Conversation)は別々に増える
  // 可能性があるため。
  //
  // 【現状の実装範囲】このラウンドでは、実際にLINE Webhook/Mercari
  // 問い合わせAPI/Emailプロバイダのいずれからもメッセージを受信する
  // 経路を実装していない(§51以降=Priority 6、外部サービスの実仕様
  // 確認が別途必要なため) — スキーマ・状態遷移ロジック・受信箱UI・
  // AI下書き編集・送信前確認・送信自体の骨組みまでを用意し、ADMIN
  // 限定の「テスト会話を作成」機能(ZaicoSyncPanel.tsxの「1件同期
  // （テスト用）」と同じ考え方)で実際に動作を確認できるようにしてい
  // る。実チャネルからの受信(recordIncomingMessage相当)は、各チャネル
  // のWebhook/pollingハンドラが将来これを呼び出す形で接続する。
  // ─────────────────────────────────────────────────────────────────────
  MessageChannel: a.enum(["MERCARI_SHOPS", "YAHOO_AUCTION", "LINE", "EMAIL", "BASE", "TEST"]), // TEST = ADMIN限定のテスト会話作成専用(§166 Message Definition of Doneの動作確認用)。実チャネルと混同しないよう一覧では明示的に区別する。

  ConversationStatus: a.enum(["OPEN", "WAITING_FOR_REPLY", "REPLIED", "RESOLVED", "ARCHIVED"]),

  ConversationPriority: a.enum(["NORMAL", "HIGH"]),

  /**
   * 業務上の確認状況。既読/未読(技術的状態)とは**別軸**で持つ。
   *
   * 【なぜ分けるか】「未読」は人がまだ開いていないという事実で、
   * 「返信済み」「大原確認」は業務がどこまで進んだかという事実。
   * 1つのstatusに混ぜると「既読にしたら返信済みになった」のような
   * 取り違えが起きる。Conversation.isUnread/lastReadAt が前者、
   * このworkflowStatusが後者を担う。
   */
  /**
   * 業務ステータス。返信したかどうか(replyState)とは**別軸**。
   *
   * 2026-09-02: COMPLETED(対応済み)を追加。「返信済み」と「対応済み」は
   * 別概念 —— 配送予定日を回答済みでも配送前なら返信済みであって
   * 対応済みではない。既存の NEW / REPLIED はデータ互換のために残す
   * (値を消すとその値を持つ既存行が読めなくなる)。UI上は両方とも
   * 「確認指定なし」として扱い、返信状態は needsReply から導く。
   */
  /**
   * 業務ステータス。返信状態(needsReply)とは**別の軸**。
   *
   * AWAITING_PRODUCT_URL は「商品URLを送ってもらう返信をしたので、
   * お客様の返答を待っている」状態。既存の軸を壊さずに足してある:
   *
   *   返信状態     … REPLIED(こちらは返信済み)
   *   業務ステータス … AWAITING_PRODUCT_URL(まだ本題に入れていない)
   *
   * 「返信済み」と「対応済み」の間にある状態を表現できないと、
   * URL依頼を送った会話が「返信済み」のまま一覧に埋もれ、
   * お客様からURLが届いても誰も気づかない。
   */
  ConversationWorkflowStatus: a.enum([
    "NEW",
    "REPLIED",
    "AWAITING_PRODUCT_URL",
    "OHARA_REVIEW",
    "ICHIKAWA_REVIEW",
    "COMPLETED",
  ]),

  /** 受信メッセージの種別。画像を「本文が空のテキスト」として捨てないために要る。 */
  MessageContentKind: a.enum(["TEXT", "IMAGE", "STICKER", "FILE", "OTHER"]),

  /** 添付バイナリをBELLO側へ保存できたか。取得失敗を会話の消失にしないため、状態として持つ。 */
  MessageAttachmentStatus: a.enum(["NONE", "PENDING", "STORED", "FAILED"]),

  MessageDirection: a.enum(["INBOUND", "OUTBOUND"]),

  MessageSenderType: a.enum(["CUSTOMER", "STAFF", "AI"]),

  MessageDeliveryStatus: a.enum(["RECEIVED", "DRAFT", "SENDING", "SENT", "FAILED"]),

  /** §40 Conversation Model。 */
  Conversation: a
    .model({
      channel: a.ref("MessageChannel").required(),
      externalConversationId: a.string(), // 実チャネル側の会話ID(TESTチャネルではnull)
      externalCustomerId: a.string(),
      customerDisplayName: a.string(),
      relatedInventoryId: a.string(), // → Inventory.id(READ ONLY境界: このモデルもInventoryを書き込まない、参照のみ)
      /**
       * この会話で特定できたBASE商品ID。
       *
       * 一度URLから特定できたら記録しておき、次の受信のたびにBASE APIへ
       * 問い合わせ直さない。relatedInventoryId とは別に持つ ——
       * BASE商品が特定できても、対応するBELLO在庫が見つからないことが
       * ある(BaseProductArchive 267件に対し在庫紐付けは0件、という実測)。
       * 片方だけ分かっている状態を表現できないと、分かった事実まで捨てる
       * ことになる。
       */
      relatedBaseItemId: a.string(),
      relatedListingId: a.string(), // → ChannelListing.id
      relatedOrderId: a.string(), // 将来のOrder機能用に予約(§136: 今回は無理に二重Sales/Orderモデルを作らない、のでこのフィールドは現状常にnull)
      subject: a.string(),
      status: a.ref("ConversationStatus").required(),
      unreadCount: a.integer().default(0),
      needsReply: a.boolean().default(false), // lib/messaging/conversationStatus.tsのderiveNeedsReplyが算出する値をそのまま保存(§121の一覧ソートで使うため、毎回全メッセージを読み直して計算しない)
      priority: a.ref("ConversationPriority"), // 未設定はアプリケーション側でNORMAL扱い(a.ref()はa.enum()と違いdefault()を持たないため — lib/messaging配下の読み取り関数がnull→NORMALのフォールバックを行う)
      lastMessagePreview: a.string(),
      lastMessageAt: a.datetime(),
      lastIncomingAt: a.datetime(),
      lastOutgoingAt: a.datetime(),
      assignedUserId: a.string(),
      /**
       * 未読フラグ。unreadCountは**加算しかされておらず、0へ戻す経路が
       * コード中に1つも無かった**(実測: lib/messaging/webhookStore.ts と
       * service.ts の該当箇所はすべて +1 のみ)。これが「会話を開いても
       * 未読が消えない」の正体。件数ではなく真偽値を正本にし、
       * 「人が開いた」操作だけがfalseにする。
       */
      isUnread: a.boolean().default(true),
      /** 人が実際に画面で開いた時刻。AI生成・Webhook・バックグラウンド処理では更新しない。 */
      lastReadAt: a.datetime(),
      lastReadBy: a.string(),
      /** 業務ステータス(未読/既読とは別軸 — ConversationWorkflowStatusのコメント参照)。 */
      workflowStatus: a.ref("ConversationWorkflowStatus"),
      /**
       * 「対応済み」にした日時。対応済み一覧の並び順に使う。
       * 解除したらnullへ戻す(履歴は InventoryHistory ではなく
       * Conversation.updatedBy/updatedAt で追う)。
       */
      completedAt: a.datetime(),
      completedBy: a.string(),
      /**
       * 会話の確定情報(2026-09-03 追加指示 §17-§25)。JSON文字列。
       *
       * 「https://…/items/156144635 3万円まで下げられますか」→
       * 「お届け先の都道府県を教えてください」→「埼玉です」の3通目で、
       * 商品・希望価格・交渉であることが**毎回失われていた**。履歴の本文を
       * AIへ渡すだけでは足りない —— 一度確定した事実を文章から読み直すと、
       * 短い返答のターンで読み取れずに消える。構造として保持する。
       *
       * 【なぜ別モデルにしないか】会話と1対1で、会話が消えれば無意味になる。
       * 別テーブルにすると読み書きが2往復になり、Webhookの中で同期処理して
       * いる今の構成では遅延がそのまま顧客への返信遅れになる。
       *
       * 中身の型は lib/inquiry/conversationContext.ts の ConversationContext。
       */
      inquiryContext: a.string(),
      /**
       * inquiryContext の版数。**同一会話へ短時間に2通届いたときの
       * lost update を防ぐ**ために使う(§25)。
       *
       * 「埼玉です」「できれば今週欲しいです」が連続で届くと、2つの処理が
       * 同じ版を読んで別々に書き戻し、片方の更新が消える。書き込みは
       * 「読んだ版と一致するときだけ」成立させ(条件付き更新)、外れたら
       * 読み直してマージし直す —— lib/inquiry/contextStore.ts。
       */
      inquiryContextVersion: a.integer(),
      /** 顧客名をいつ外部APIから取得したか。毎回LINE APIを叩かないためのキャッシュ判定に使う。 */
      customerNameFetchedAt: a.datetime(),
      /** 顧客名の出所("LINE_PROFILE"等)。取得できなかったのか、そもそも取りに行っていないのかを区別する。 */
      customerNameSource: a.string(),
      /**
       * 論理削除。AI返信ログ・監査データから参照され得るため物理削除しない
       * (§3の「履歴・監査上残す必要があるデータを不用意に消さない」)。
       * 一覧・詳細・AI参照はすべてこれがnullの会話のみを対象にする。
       */
      deletedAt: a.datetime(),
      deletedBy: a.string(),
      createdBy: a.string(),
      updatedBy: a.string(),
    })
    .secondaryIndexes((index) => [index("relatedInventoryId"), index("status")])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR"),
      allow.group("VIEWER").to(["read"]),
    ]),

  /** §41 Message Model。 */
  Message: a
    .model({
      conversationId: a.string().required(),
      externalMessageId: a.string(),
      direction: a.ref("MessageDirection").required(),
      senderType: a.ref("MessageSenderType").required(),
      body: a.string().required(),
      contentType: a.string(), // 例: "text"/"image" — 添付ありメッセージのUI表示分岐用(§53: 添付解析までは今回未実装、表示のみ)
      externalSentAt: a.datetime(),
      deliveryStatus: a.ref("MessageDeliveryStatus").required(),
      aiGenerated: a.boolean().default(false), // §134: AI生成文章かどうかの内部フラグ
      /**
       * メッセージ種別。以前は画像イベントを parseLineWebhookBody が
       * `message.type !== "text"` で捨てており、**画像を送られると会話に
       * 何も残らなかった**。本文が空であることを理由に捨てないために、
       * 種別を明示的に持つ。
       */
      contentKind: a.ref("MessageContentKind"),
      /** BELLO側(S3)へ保存した添付のキー。LINEの画像URLは期限切れするため、受信直後に自前へ保存する。 */
      attachmentStorageKey: a.string(),
      attachmentContentType: a.string(),
      attachmentSizeBytes: a.integer(),
      /** 取得できたか。失敗しても会話は残し、再取得可能な状態として記録する。 */
      attachmentStatus: a.ref("MessageAttachmentStatus"),
      /** 取得失敗の理由(利用者に見せる短い日本語。秘密値は含めない)。 */
      attachmentError: a.string(),
      createdBy: a.string(),
    })
    // 第五ラウンド§6(P0-B) GSI/Scan監査で追加: externalMessageId(LINE
    // 等のWebhook配送idempotency判定キー、lib/messaging/service.tsの
    // recordIncomingMessage)は必ずWHERE句として使われるのに以前は
    // 未index — 追記専用で無制限に増え続けるこのテーブルへの、Webhook
    // 受信のたびに走るfilter付きScanになっていた。既存モデルへの
    // 追加GSIは既存データを壊さない(GSIは新規追加時に既存項目へ
    // backfillされる、Amplify Gen2のAmplifyDynamoDBTableカスタム
    // リソースが管理)——synth:checkで既存の他モデル参照が壊れないこと
    // を確認済み(本round作業ログ参照)。
    .secondaryIndexes((index) => [index("conversationId"), index("externalMessageId")])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR"),
      allow.group("VIEWER").to(["read"]),
    ]),

  /**
   * 2026-09-04 追加指示 §51/§64: **注文番号 → 商品** の対応表。
   *
   * ── なぜ要るのか(実際に起きたこと) ──────────────────────────────
   *
   * メルカリShopsの取引メッセージは、注文が進むにつれて手がかりが痩せる。
   * 実データ(2026-09-03)では、同じ注文 order_2JW2rNd9i7WdFrivCjhfpw に
   * ついて3通の取引メッセージが届き、社内通知はいずれも
   * 「対象商品：特定できませんでした」だった —— **購入された商品は
   * 「販売中」カテゴリから外れる**ので、商品名で在庫を探す既存の経路が
   * 構造的に当たらない。
   *
   * 一方、購入が発生した時点で届く購入通知メールには**商品名と注文番号が
   * 必ず揃っている**。そこで購入時点で対応を作って持っておき、以後の
   * 取引メッセージはこの表を引くだけにする(§65 主経路)。
   *
   * ── なぜ Conversation に相乗りさせないのか ──────────────────────
   *
   * §53。inquiryId(会話スレッド)と orderId(注文)は別の識別子で、
   * 1つの注文に複数の問い合わせスレッドが立ちうる。会話の行へ入れると、
   * 別スレッドから同じ注文の商品を引けない —— まさにそれを可能にするのが
   * この表の目的。会話側の inquiryContext は従来どおり会話ごとの文脈を
   * 持ち続ける(役割が違うので二重管理にはならない)。
   *
   * 識別子は orderId そのもの。同じ注文のメールを何度取り込んでも
   * 行が増えない(§70 ケースG)。
   */
  MercariOrderContext: a
    .model({
      /** `order_` 接頭辞を含む正規化済みの注文番号。 */
      orderId: a.string().required(),
      /**
       * この注文に紐づく問い合わせスレッドID(複数ありうる)。
       * §53「同じ注文について複数の問い合わせスレッドが発生する可能性」。
       * 会話の主キーではない —— 会話は従来どおり inquiryId で決まる。
       */
      inquiryIds: a.string().array(),
      /** メルカリShopsの出品タイトル。購入通知・取引メッセージのどちらからでも入る。 */
      productName: a.string(),
      productPriceYen: a.integer(),
      quantity: a.integer(),
      itemAmountYen: a.integer(),
      shippingFeeYen: a.integer(),
      couponDiscountYen: a.integer(),
      totalAmountYen: a.integer(),
      /** 顧客が希望した配送日(ISO日付)。取引メッセージから分かった場合に入る。 */
      requestedDeliveryDate: a.string(),
      /** 商品名から特定できたBELLO在庫。特定できなければ null のまま残す。 */
      inventoryId: a.string(),
      displayInventoryId: a.string(),
      inventoryName: a.string(),
      /** 1件に絞れなかったときの候補。捨てない(§24と同じ方針)。 */
      inventoryCandidateIds: a.string().array(),
      /** 在庫の特定状態("RESOLVED"/"AMBIGUOUS"/"NOT_FOUND"/"NONE")。 */
      inventoryStatus: a.string(),
      baseItemId: a.string(),
      baseUrl: a.string(),
      /** 商品の特定が最後に成立した時刻。未解決なら null。 */
      resolvedAt: a.datetime(),
      /** 何を根拠にこの対応を作ったか("PURCHASE_NOTIFICATION"/"ORDER_MESSAGE"/"GMAIL_SEARCH")。 */
      evidenceSource: a.string(),
      /** 由来のGmail message ID(来歴)。どのメールからこの対応ができたかを追う。 */
      sourceGmailIds: a.string().array(),
      /**
       * 購入通知メールのGmail message ID。
       *
       * **来歴とは別に持つ。** 購入通知は Message を作らない(§63)ので、
       * メッセージ側の重複判定に載らない。取り込みは「このIDは処理済みか」を
       * ここで判定する。取引メッセージのIDまで混ぜると、Message の作成に
       * 失敗した問い合わせが「処理済み」に見えて二度と取り込まれなくなる。
       */
      purchaseMailGmailIds: a.string().array(),
      /** 購入通知を取り込んだか。false なら取引メッセージ由来だけで作られた対応。 */
      purchaseNotificationSeen: a.boolean(),
      shopId: a.string(),
      orderUrl: a.string(),
      /** 購入通知メールの受信時刻(= 実質の購入日時)。 */
      purchasedAt: a.datetime(),
      createdBy: a.string(),
      updatedBy: a.string(),
    })
    .identifier(["orderId"])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR"),
      allow.group("VIEWER").to(["read"]),
    ]),

  // ─────────────────────────────────────────────────────────────────────
  // BELLO統合業務OS指示書(2026-08-30) §61-69: 家財おまかせ便(アート
  // セッティングデリバリー)の配送ランク・料金マスタ。発送元はBELLOの
  // 所在地である埼玉県固定(§61)。ランク判定ロジックはlib/shipping/
  // rank.ts(純粋関数、9段階 SS〜G + OVERSIZE)。
  //
  // 【現状の実装範囲】公式の料金検索ツール(form.008008.jp)はJS
  // フォーム/セッション経由の動的な見積りであり、このsandbox環境の
  // WebFetchはegress proxyにより候補サイトすべてに到達できない
  // (Mercari調査時と同じ制約)。WebSearch経由で実際に確認できたのは
  // 埼玉→東京のB/Cランクの2件のみ(lib/shipping/ratesSeed.ts参照) —
  // それ以外のランク・都道府県の金額は憶測で埋めず、ADMINが設定画面
  // (ShippingRatePanel)から公式の料金検索結果を見ながら追加する運用と
  // した(§157 fake success禁止 — 未確認の金額を「実装済み」に見せか
  // けない)。
  // ─────────────────────────────────────────────────────────────────────
  ShippingRank: a.enum(["SS", "S", "A", "B", "C", "D", "E", "F", "G", "OVERSIZE"]),

  // 第六ラウンド§10: import batchの結果(VERIFIED=公式ページから実際に
  // 確認できた金額、UNAVAILABLE=公式が「このルートはサービス対象外」と
  // 明示、STALE=verifiedAtから一定期間を超えて未更新、UNCONFIRMED=
  // ADMINが手動入力しsourceReferenceはあるが正式importer検証は未実施)。
  ShippingRateStatus: a.enum(["VERIFIED", "UNAVAILABLE", "STALE", "UNCONFIRMED"]),

  /**
   * §65 ShippingRate Model — 家財おまかせ便の料金マスタ(ADMIN管理)。
   *
   * 第六ラウンド§10で追加したfield(既存fieldは無変更、破壊的置換なし):
   * taxIncluded/currency/acquiredAt/status/rawHash/importBatchId。
   * originArea/destinationArea/sourceReferenceは既存のまま維持
   * (§10の推奨fieldであるoriginAreaCode/destinationAreaCode相当を
   * 既に名前違いで持っていたため、重複追加せず既存を再利用する)。
   */
  ShippingRate: a
    .model({
      provider: a.string().required(), // 例: "アートセッティングデリバリー"
      service: a.string().required(), // 例: "家財おまかせ便"
      originPrefecture: a.string().required(), // 常に"埼玉県"(§61) — 将来複数拠点になった場合に備えてDBには持たせる
      originArea: a.string(), // 地域細分(§66調査では未確認のため現状常にnull)
      destinationPrefecture: a.string().required(),
      destinationArea: a.string(),
      rank: a.ref("ShippingRank").required(),
      price: a.integer(), // 税込。UNAVAILABLE行はnull(0円で埋めない、§9/§84)
      taxIncluded: a.boolean().default(true), // 公式表示が税別の場合はfalseにしrawの値をsurchargeやsourceReference側に残す
      currency: a.string().default("JPY"),
      surcharge: a.integer(), // 繁忙期加算等(存在は確認済み、金額は未確認 — §66)
      effectiveFrom: a.date(),
      effectiveTo: a.date(),
      sourceReference: a.string(), // 出典(URL・検索クエリ・確認日等) — 憶測値でないことの根拠を必ず残す
      acquiredAt: a.datetime(), // importerが実際にこの値を取得した日時(verifiedAtは人が確認した日時——別概念、既存のまま)
      verifiedAt: a.datetime(),
      status: a.ref("ShippingRateStatus"), // 未設定(null)= 第五ラウンド以前の手動投入行(既存データ互換)
      rawHash: a.string(), // 取得したraw値のhash——再importでの差分検出用(同一なら書き込みを抑制)
      importBatchId: a.string(), // このrateを書いたShippingImportBatch.id(手動投入行はnull)
      version: a.integer().default(1),
      createdBy: a.string(),
      updatedBy: a.string(),
    })
    // 発送元は常に埼玉県固定のため索引に含めない。着地+ランクで絞り込み、
    // 複数該当時はlib/shipping/service.ts側でeffectiveFrom/versionにより
    // 最新のものを選ぶ。
    .secondaryIndexes((index) => [index("destinationPrefecture").sortKeys(["rank"])])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read"]),
      allow.group("VIEWER").to(["read"]),
    ]),

  ShippingImportBatchStatus: a.enum(["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]),

  /**
   * 第六ラウンド§11: 公式料金データの取得batch1回につき1行。
   * lib/shipping/importer.tsが読み書きする——ZaicoSyncJobと同じ
   * lease/checkpoint/retry設計思想(amplify/functions/zaico-sync-worker/
   * のコメント参照)を、単一シングルトンではなく「batch実行のたびに
   * 新規行」という形で採用している(過去のimport履歴を全て残せる
   * 利点があるため、ZaicoSyncJobのsingleton方式は踏襲しない)。
   */
  ShippingImportBatch: a
    .model({
      status: a.ref("ShippingImportBatchStatus").required(),
      sourceUrl: a.string().required(), // 公式料金検索ページのURL(取得元の証跡)
      expectedCells: a.integer().default(0), // 全destination×全rankの期待組合せ数
      verifiedCells: a.integer().default(0),
      unavailableCells: a.integer().default(0),
      missingCells: a.integer().default(0), // 取得を試みたが結果を得られなかった組合せ(0円扱いにしない、§9)
      failedCells: a.integer().default(0),
      changedCells: a.integer().default(0), // 既存verified値からrawHashが変化した件数
      unchangedCells: a.integer().default(0), // rawHash一致でDB write抑制した件数
      lastDestinationProcessed: a.string(), // resume用checkpoint
      lastRankProcessed: a.ref("ShippingRank"),
      lastError: a.string(),
      leaseOwner: a.string(), // 同時import二重実行防止(§103)
      leaseExpiresAt: a.datetime(),
      retryCount: a.integer().default(0),
      startedAt: a.datetime(),
      finishedAt: a.datetime(),
      triggeredBy: a.string(),
    })
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read"]),
    ]),

  // ─────────────────────────────────────────────────────────────────────
  // BELLO 統合業務OS ベンダー非依存・交換可能アーキテクチャ仕様書
  // (2026-08-30) §6/§15: AI呼び出しの監査ログ。プロンプト全文・顧客
  // メッセージ本文・内部メモ等は一切保存しない(仕様書「全文promptを
  // 監査目的だけで無制限保存しない」「秘密情報や顧客個人情報を不要に
  // 保存しない」への対応) — 保存するのはtask/provider/model/tier/
  // トークン数/概算コスト/成功可否/fallback発生有無/品質ゲート結果/
  // promptVersionといったメタデータのみ。lib/ai/gateway/usageLog.ts
  // が実際の書き込みを行う。
  // ─────────────────────────────────────────────────────────────────────
  AITaskName: a.enum(["LISTING_TITLE_GENERATION", "LISTING_DESCRIPTION_GENERATION", "CUSTOMER_REPLY_DRAFT", "PRODUCT_INFORMATION_EXTRACTION", "CLASSIFICATION"]),

  AIQualityTierName: a.enum(["ECONOMY", "STANDARD", "PREMIUM"]),

  /** §15 Observability/Cost — AI呼び出し1回につき1行。 */
  AIUsageLog: a
    .model({
      task: a.ref("AITaskName").required(),
      providerId: a.string().required(), // 例: "anthropic"
      modelId: a.string().required(),
      qualityTier: a.ref("AIQualityTierName").required(),
      inputTokens: a.integer().required(),
      outputTokens: a.integer().required(),
      estimatedCostUsd: a.float(), // lib/ai/gateway/modelRegistry.tsの単価から算出、取得不能ならnull
      latencyMs: a.integer().required(),
      success: a.boolean().required(),
      errorMessage: a.string(), // 失敗時のみ、技術的詳細(顧客データは含まない)
      retryCount: a.integer().default(0),
      fallbackOccurred: a.boolean().default(false), // §4.1: ECONOMY/STANDARD→PREMIUMのescalationが発生したか
      qualityGatePassed: a.boolean(),
      qualityGateViolations: a.json(), // string[] — 違反ラベルのみ(生成本文は含まない)
      promptVersion: a.string().required(),
    })
    // Amplify Dataの自動付与createdAtはsecondaryIndexesのsortKeysに
    // 指定できない(明示的なmodelフィールドしか使えない、synth時に
    // 実際にエラーで確認済み)ため、taskのみで索引する — 月次集計は
    // 呼び出し元(lib/ai/gateway/auditReport.ts)がtask別の全件を取得後
    // JS側でcreatedAtにより絞り込む(件数がAI呼び出し回数程度である
    // 前提であれば許容範囲、lib/inventory/queries.tsの他の集計と同じ
    // 考え方)。
    .secondaryIndexes((index) => [index("task")])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read"]),
      allow.group("VIEWER").to(["read"]),
    ]),

  // ─────────────────────────────────────────────────────────────────────
  // BELLO画像自動加工システム(2026-08-30指示書)§15 データモデル。
  // ImageAsset/ProductCompositionProfile相当はInventoryImage customType
  // 自身へ折り込んだ(上のコメント参照)。ここでは「画像1件に対して複数
  // 存在し、独立に検索・一覧・rollbackする必要がある」3モデルのみ新設
  // する。processingVersion/photoProfileVersion/engineVersionは全てこの
  // ラウンドで導入した最初のバージョン(=1)から始まる整数。
  // ─────────────────────────────────────────────────────────────────────

  ProcessingJobTriggerType: a.enum(["CATEGORY_TRANSITION", "NEW_IMAGE", "MANUAL_REPROCESS"]),
  ProcessingJobStatus: a.enum(["PENDING", "PROCESSING", "DONE", "FAILED", "DEAD_LETTER"]),

  /**
   * §15.5 ProcessingJob — 加工キュー。amplify/functions/
   * image-processing-worker/がスケジュール実行でPENDING行をScanし、
   * lib/inventory/pricing-scheduler(amplify/functions/pricing-scheduler)
   * と同じ「Scan→1件ずつ処理→GSIを持たないUPDATE限定の更新」パターンを
   * 再利用する(このラウンドで確立したUpdateItem安全性の原則、
   * amplify/functions/pricing-scheduler/resource.tsのコメント参照)。
   * `idempotencyKey`(storageKey+originalHash+engineVersion+
   * photoProfileVersionから決定的に算出、lib/imageProcessing/
   * jobService.tsのbuildIdempotencyKey)で同一内容の重複ジョブ作成を
   * 防ぐ(§11.4 冪等性)。GSIは意図的に持たせない(このテーブルの検索は
   * 常にstatus値でのScan+FilterExpressionのみ、pricing-schedulerの
   * PriceExecutionLogと同じ設計判断)。
   */
  ProcessingJob: a
    .model({
      inventoryId: a.string().required(),
      imageStorageKey: a.string().required(), // どのInventoryImage(storageKeyで特定)向けのジョブか
      triggerType: a.ref("ProcessingJobTriggerType").required(),
      idempotencyKey: a.string().required(),
      status: a.ref("ProcessingJobStatus").required(),
      attemptCount: a.integer().default(0),
      queuedAt: a.datetime().required(),
      startedAt: a.datetime(),
      completedAt: a.datetime(),
      errorCode: a.string(),
      errorMessage: a.string(),
      // §12 画像単位の再加工: ユーザーが選んだ再加工理由/要求パラメータ
      // (明るさ調整・1:1↔3:2変更・床補正の強弱等)。MANUAL_REPROCESS以外
      // では常にnull。
      requestedAdjustments: a.json(),
    })
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR"),
      allow.group("VIEWER").to(["read"]),
    ]),

  /**
   * §15.2 ImageProcessingVersion — 1画像につき複数行(version昇順)。
   * どのversionが採用中かは`active`フラグで表す(InventoryImage側には
   * 一切書き込まない設計——上のInventoryImage customTypeコメント参照。
   * ちょうど1行だけactive=trueというアプリ側の不変条件はlib/
   * imageProcessing/jobService.tsのsetActiveVersion——新しいactiveを
   * 立てる前に旧activeを先に降ろす、2回の独立UPDATE——が保証する。
   * 検索はsecondaryIndexes(imageStorageKey)を使い、Scanは行わない)。
   * 旧versionはSUPERSEDEDのまま消さない(§12「旧版を即削除せず…直前版
   * へ戻せる」)。
   */
  ImageProcessingVersion: a
    .model({
      inventoryId: a.string().required(),
      imageStorageKey: a.string().required(),
      version: a.integer().required(),
      active: a.boolean().default(false),
      aspectRatio: a.ref("ImageAspectRatio"),
      cropRect: a.json(), // {x,y,width,height} — 正規化座標(0.0〜1.0)
      occupancy: a.float(), // 被写体占有率の実測値(§6 目標65〜75%/60〜70%との比較用)
      // §8.3 補正対象をまとめて1つのjsonへ(exposure/wb/temperature/tint/
      // highlight/shadow/contrast/saturation) — 個別列にすると
      // Photo Profileの調整項目が増えるたびにスキーマmigrationが必要に
      // なるため、意図的にjson一本化(lib/imageProcessing/types.tsの
      // ToneAdjustments型がこのjsonの実体を定義する)。
      adjustments: a.json(),
      floorCleanupEnabled: a.boolean().default(false),
      floorCleanupStrength: a.float(), // 0.0〜1.0。floorCleanupEnabled=falseなら常にnull
      photoProfileVersion: a.integer(), // 生成時にACTIVEだったPhotoProfile.version
      engineVersion: a.integer().required(), // lib/imageProcessing/sharpProcessor.tsのENGINE_VERSION
      status: a.ref("ImageProcessingStatus").required(),
      failureCode: a.string(),
      failureDetail: a.string(),
      processedMasterKey: a.string(), // 高品質JPEGマスターのS3キー
      webKey: a.string(),
      thumbnailKey: a.string(),
      startedAt: a.datetime(),
      completedAt: a.datetime(),
    })
    .secondaryIndexes((index) => [index("imageStorageKey")])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR"),
      allow.group("VIEWER").to(["read"]),
    ]),

  /**
   * §15.4 / §8.1 PhotoProfile — 管理画面から編集するBELLO全体の理想写真
   * 基準。ACTIVEは常に高々1件(lib/imageProcessing/photoProfileService.ts
   * が保証する、DB制約ではなくアプリ側ロジック — 他の「singleton」行
   * (BaseOAuthToken等)と異なり複数バージョンを履歴として残す必要が
   * あるため、テーブル自体はマルチ行、ACTIVE切替はフラグの付け替えで
   * 実装する)。
   */
  PhotoProfile: a
    .model({
      name: a.string().required(),
      referenceImageKeys: a.json().required(), // string[] — S3キー(photo-profile/プレフィックス)
      targetOccupancySquare: a.json(), // {min,max} — §6の1:1初期値65〜75%
      targetOccupancyLandscape: a.json(), // {min,max} — §6の3:2初期値60〜70%
      compositionDefaults: a.json(), // その他の構図既定値(safeMargins等)
      version: a.integer().required(),
      active: a.boolean().default(false),
    })
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read"]),
      allow.group("VIEWER").to(["read"]),
    ]),

  // ─────────────────────────────────────────────────────────────────────
  // AI問い合わせ返信・商品自動特定・ナレッジ文書管理 仕様書(2026-09-01)
  // §5/§17/§20/§43。すべて**新規モデル**であり、既存モデルへのフィールド
  // 追加・変更は一切行わない(§30 破壊的マイグレーション禁止)。
  // ─────────────────────────────────────────────────────────────────────

  /**
   * §5.5 KnowledgeDocument — 設定画面から登録するBELLOの社内文書。
   *
   * 【原本と検索用テキストを分ける理由】原本はS3(Amplify Storage)へ置き、
   * DynamoDBには検索用の抽出テキストだけを持つ。ダウンロードは原本の
   * バイト列をそのまま返さないと「上げた物と同じ物が落ちてくる」保証が
   * できない(§5.3)。一方、問い合わせのたびに全文書のS3オブジェクトを
   * 読むのは遅く高くつくので、検索はDynamoDB側のsearchTextだけで完結
   * させる。
   *
   * searchTextはKNOWLEDGE_SEARCH_TEXT_MAX_CHARSで切り詰める(DynamoDBの
   * 1項目400KB制限に対する安全弁 — lib/knowledge/limits.ts)。切り詰めが
   * 起きたかはsearchTextTruncatedで分かるようにし、「なぜ検索に出ないか」
   * を後から説明できるようにする。
   */
  KnowledgeDocument: a
    .model({
      /** S3上のキー(inventory/knowledge/<uuid><ext>)。表示名ではない。 */
      storageKey: a.string().required(),
      /** アップロード時のファイル名(sanitize済み)。ダウンロード時のファイル名に使う。 */
      originalFileName: a.string().required(),
      title: a.string().required(),
      description: a.string(),
      category: a.string(),
      mimeType: a.string().required(),
      sizeBytes: a.integer().required(),
      /** 検索用に抽出した本文(切り詰めあり)。原本はS3側。 */
      searchText: a.string(),
      searchTextTruncated: a.boolean().default(false),
      /** 一覧上の有効/無効。falseなら検索対象にもAI参照対象にもしない。 */
      isActive: a.boolean().default(true),
      /** AI参照ON/OFF(§5.2)。isActiveがtrueでもこれがfalseならAIへは渡さない。 */
      aiReferenceEnabled: a.boolean().default(true),
      /** 原本のSHA-256(§23)。差し替え検出・監査用。 */
      checksum: a.string(),
      /** 差し替えのたびに+1(§23 最低限のバージョン)。 */
      version: a.integer().default(1),
      sortOrder: a.integer().default(0),
      createdBy: a.string(),
      updatedBy: a.string(),
    })
    .authorization((allow) => [
      // 管理(作成・差し替え・削除)はADMINのみ(§22)。EDITOR/VIEWERは読み取り
      // のみ — AI返信の根拠として本文が必要なため。
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read"]),
      allow.group("VIEWER").to(["read"]),
    ]),

  ReplyDraftStatus: a.enum([
    "GENERATING",
    "READY",
    "NEEDS_PRODUCT_CONFIRMATION",
    "NEEDS_CUSTOMER_INFO",
    "RESEARCH_INCOMPLETE",
    "FAILED",
    "USED",
    "DISMISSED",
  ]),

  /**
   * §17/§18 ReplyDraft — 生成した返信案1件。
   *
   * 顧客メッセージ本文・外部サイトの取得文・Secretはここへ複製しない
   * (§17末尾)。draftTextは顧客へ送る文面そのものなので保存するが、根拠
   * (sourceSummary)は「どの文書のどの見出しを使ったか」という参照情報
   * だけを持ち、外部ページの本文は持たない。
   */
  ReplyDraft: a
    .model({
      conversationId: a.string().required(),
      sourceMessageId: a.string().required(),
      resolvedInventoryId: a.string(),
      productMatchConfidence: a.float(),
      /** InquiryIntentの配列をJSONで保持(a.enum().array()はAmplify Dataで扱えないため)。 */
      intents: a.json(),
      draftText: a.string(),
      /** 「分からないままにした事実」の一覧(§3)。UnresolvedFactのJSON配列。 */
      unresolvedFacts: a.json(),
      /** §33 参照情報。ReplyEvidenceのJSON。 */
      sourceSummary: a.json(),
      modelProvider: a.string(),
      modelName: a.string(),
      status: a.ref("ReplyDraftStatus").required(),
      /** 生成が失敗した場合の管理者向け説明(顧客には出さない)。 */
      failureReason: a.string(),
      createdBy: a.string(),
      updatedBy: a.string(),
    })
    .secondaryIndexes((index) => [index("conversationId"), index("sourceMessageId")])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR"),
      allow.group("VIEWER").to(["read"]),
    ]),

  /**
   * §42/§43 AI返信の運用設定。1行だけ(id: "singleton")。
   *
   * autoSendEnabledは**必ずfalse始まり**(§41)。将来自動送信を実装する
   * 場合でも、このフラグをtrueにする操作は人が明示的に行う。
   */
  AIReplySettings: a
    .model({
      /** 返信案の生成を許可するか(§43 初期ON)。falseならUIのボタンも無効化する。 */
      autoDraftEnabled: a.boolean().default(true),
      /** 外部Webリサーチを許可するか(§43 初期ON)。falseなら不明点は不明のまま。 */
      webResearchEnabled: a.boolean().default(true),
      /** ナレッジ文書をAIへ渡すか(§43 初期ON)。 */
      knowledgeEnabled: a.boolean().default(true),
      /** 顧客への自動送信(§41 常にfalse始まり。今回のUIからtrueにはできない)。 */
      autoSendEnabled: a.boolean().default(false),
      updatedBy: a.string(),
    })
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read"]),
      allow.group("VIEWER").to(["read"]),
    ]),

  // ─────────────────────────────────────────────────────────────────
  // 問い合わせAI管理センター(2026-09-03 指示書 §16/§8/§6)。
  //
  // 【なぜ Inquiry モデルを新設しないか】指示書§9は共通の問い合わせ形式を
  // 求めているが、Conversation + Message が既にその形を持っている
  // (channel / externalConversationId / externalCustomerId /
  //  customerDisplayName / relatedInventoryId / relatedBaseItemId、
  //  Message 側に externalMessageId と本文)。もう1つ Inquiry を作ると
  // 同じ事実が2箇所に書かれ、どちらが正かが曖昧になる。指示書§20
  // 「既存資産を捨てない」と§30「旧モデルを消さない」に従い、
  // Conversation/Message を問い合わせの正本として使い続け、足りない
  // 「返信ルール」「通知の配送状態」「通知先」だけをここで足す。
  // ─────────────────────────────────────────────────────────────────

  /** §16-1 返信ルールの分類。 */
  ReplyRuleCategory: a.enum([
    "DISCOUNT",
    "SHIPPING",
    "DELIVERY_DATE",
    "PRODUCT_CONDITION",
    "RESERVATION",
    "STOCK",
    "RETURN",
    "CANCELLATION",
    "RECEIPT",
    "PAYMENT",
    "SIZE",
    "REPAIR",
    "OTHER",
  ]),

  /**
   * §16 返信ルール — 「どう判断するか」。
   *
   * 【ナレッジ文書と混ぜない】§19が明確に分けている。
   *   ReplyRule : どう判断するか(配送先が不明な値下げ交渉では都道府県を訊く)
   *   Knowledge : 判断に必要な情報(らくらく家財便のサイズ別送料)
   * KnowledgeDocument は S3 の原本を持つ文書置き場で、改訂履歴もファイル
   * 差し替えを前提にしている。ルールは1件が短く、優先度・チャネル・
   * カテゴリーで絞って**必要なものだけ**AIへ渡したい(§22「全DBを毎回
   * 丸ごと渡さない」)。性質が違うので別モデルにする。
   *
   * 【コードから移さないもの】金額計算・14日判定・商品特定は引き続き
   * コードが持つ(lib/knowledge/businessRules.ts の方針を継承)。ここに
   * 入るのは判断方針と言い回しであって、事実の確定ではない。
   */
  ReplyRule: a
    .model({
      title: a.string().required(),
      category: a.ref("ReplyRuleCategory").required(),
      /** 一覧で何のルールか分かるようにする短い説明。AIへは渡さない。 */
      description: a.string(),
      /** どんなときに適用するか。人が読む条件文で、AIへもそのまま渡す。 */
      conditions: a.string(),
      /** どう判断し、どう返すか。AIへ渡る本体。 */
      instruction: a.string().required(),
      /** 小さいほど先に適用する。同点なら title 順で安定させる。 */
      priority: a.integer().default(100),
      enabled: a.boolean().default(true),
      /**
       * 適用チャネル(MessageChannel の値の配列をJSONで持つ)。
       * 未設定・空配列は「全チャネル」。a.ref().array() が Amplify Data で
       * 扱えないため、ReplyDraft.intents と同じくJSONで持つ。
       */
      channelScope: a.json(),
      /** 適用する商品カテゴリー(Category.id の配列)。未設定・空は全部。 */
      productCategoryScope: a.json(),
      /** 編集のたびに +1。どの版で生成したかをAI処理ログから追える。 */
      version: a.integer().default(1),
      /**
       * ソフトデリート(§26)。過去のAI処理ログが「どのルールを使ったか」で
       * このidを参照するため、物理削除しない。
       */
      deletedAt: a.datetime(),
      deletedBy: a.string(),
      createdBy: a.string(),
      updatedBy: a.string(),
    })
    .secondaryIndexes((index) => [index("category")])
    .authorization((allow) => [
      // 編集はADMINのみ。返信の判断基準そのもので、誤編集の影響が大きい。
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read"]),
      allow.group("VIEWER").to(["read"]),
    ]),

  /**
   * §8 通知の配送状態。
   *
   * 【WAITING_FOR_TARGET を分けた理由】2026-09-03 追加指示§7。通知先が
   * 未登録なだけの状態を DEAD_LETTER(恒久停止)にしていたため、解析は
   * 成功しているのに画面が「停止(要対応)」と表示していた。**解析の失敗と
   * 通知先の未設定は別物**で、後者は友だち追加すれば送れる。再送可能な
   * 状態として分けておく。
   *
   * 【SUPERSEDED】本文抽出の不具合で作られた通知を、再処理後に「置き換え
   * 済み」として残すための状態。消さずに残すことで、どの通知がどの再処理で
   * 置き換わったかを後から追える(§10 不可逆な一括削除をしない)。
   */
  NotificationDeliveryStatus: a.enum([
    "PENDING",
    "PROCESSING",
    "SENT",
    "FAILED",
    "DEAD_LETTER",
    "WAITING_FOR_TARGET",
    "SUPERSEDED",
    /**
     * 送る必要が無いと人が判断したもの。初回バックフィルや開発検証で
     * 生成された履歴がこれにあたる。
     *
     * WAITING_FOR_TARGET のまま残すと、通知先が登録された瞬間に
     * **過去分が一斉に飛ぶ**。それを避けつつ、記録自体は消さずに残す。
     * 本物の新規問い合わせが一時的に送れなかった場合の再送経路
     * (WAITING_FOR_TARGET → 再送)は維持する。
     */
    "NOT_REQUIRED",
  ]),

  /** §33 通知の優先度。1通目の先頭へ【要確認】を出すかの判断に使う。 */
  NotificationPriority: a.enum(["NORMAL", "ATTENTION", "URGENT", "PARSE_ERROR"]),

  /**
   * §8 社内LINE Botへの通知1件。
   *
   * 【問い合わせ本体と分ける理由】§8が明示している。LINE送信の失敗で
   * 問い合わせデータ自体を失ってはいけない。受信・解析・返信案生成までは
   * Conversation/Message/ReplyDraft に確定させ、通知はここで独立に
   * 再試行する。送れなくても問い合わせは残る。
   *
   * 【無限に通知しない】§8末尾。dedupeKey で同じ問い合わせの通知を1件に
   * 固定し、attemptCount が上限に達したら DEAD_LETTER で止める。
   */
  NotificationDelivery: a
    .model({
      /**
       * 重複送信防止キー。"<channel>:<conversationId>:<sourceMessageId>" の形。
       * Webhookの再送やリトライで2件目を作らないための一意キー(§10 冪等性)。
       */
      dedupeKey: a.string().required(),
      conversationId: a.string(),
      sourceMessageId: a.string(),
      /** 生成元の返信案。AI処理ログから通知結果へ辿るために持つ。 */
      replyDraftId: a.string(),
      channel: a.ref("MessageChannel"),
      priority: a.ref("NotificationPriority"),
      status: a.ref("NotificationDeliveryStatus").required(),
      /** 1通目(問い合わせ内容・判断材料)。送った文面そのもの。 */
      summaryText: a.string(),
      /** 2通目(返信提案)。顧客へそのまま貼れる完成文。 */
      replyText: a.string(),
      attemptCount: a.integer().default(0),
      lastAttemptAt: a.datetime(),
      sentAt: a.datetime(),
      /** 失敗理由。短い日本語で、トークン等の秘密値は入れない(§6-1)。 */
      errorMessage: a.string(),
      /**
       * 解析側の状態(§7)。通知の状態(status)とは**別軸**。
       *
       * "OK" / "NEEDS_REVIEW" / "PARSE_FAILED" / "GENERATION_FAILED"。
       * 一覧で「解析は済んでいるが通知待ち」と「解析自体が失敗」を
       * 区別するために持つ。毎回ReplyDraftを読みに行かなくて済むよう、
       * 通知の作成時に確定した値を写しておく。
       */
      analysisStatus: a.string(),
      /** メール由来の問い合わせ種別(PRODUCT_INQUIRY / ORDER_MESSAGE)。 */
      inquiryKind: a.string(),
      /** 取引メッセージのときの注文番号(§9 1通目に出す)。 */
      orderNumber: a.string(),
      /** この通知を置き換えた新しい通知のid(SUPERSEDED のときだけ)。 */
      supersededBy: a.string(),
      createdBy: a.string(),
    })
    .secondaryIndexes((index) => [index("dedupeKey"), index("status"), index("conversationId")])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR"),
      allow.group("VIEWER").to(["read"]),
    ]),

  /**
   * §4-3/§6 社内通知用LINE Botの接続設定。1行だけ(id: "singleton")。
   *
   * 【トークンはここに入れない】Channel access token / Channel secret は
   * AWS Secrets Manager(bello/line-notify-bot)にのみ置く。このモデルが
   * 持つのは「誰へ送るか」「画面に何を出すか」という秘密でない情報だけ。
   *
   * 【targetUserId を手入力させない】LINEのユーザーIDは人が見て分かる値では
   * なく、コンソールからの転記はほぼ確実に間違える。Botを友だち追加した
   * ときの follow イベントで自動登録する
   * (app/api/line/notify-webhook/route.ts)。
   */
  LineNotifySettings: a
    .model({
      /** 通知先のLINEユーザーID。follow イベントで自動登録する。 */
      targetUserId: a.string(),
      targetDisplayName: a.string(),
      followedAt: a.datetime(),
      /** 友だち追加用のURL。QRが未設定でもこれがあれば案内できる。 */
      addFriendUrl: a.string(),
      /** 友だち追加QRの画像URL(§4-3 コードへベタ書きしない)。 */
      qrImageUrl: a.string(),
      botDisplayName: a.string(),
      lastNotifiedAt: a.datetime(),
      /** 直近の通知結果(§6 表示項目)。NotificationDeliveryStatus の文字列。 */
      lastNotifyStatus: a.string(),
      /**
       * 通知BotのWebhookを最後に受け取った日時と、その処理結果。
       *
       * SSRのconsoleログはCloudWatchへ届かない(d44d8e0で確認済み)ため、
       * Webhookの中で起きた失敗が**どこからも見えない**。実際、LINEからの
       * follow相当のリクエストが200で返っているのに通知先が登録されない、
       * という状態を切り分けられなかった。受信そのものを残す。
       */
      lastWebhookAt: a.datetime(),
      lastWebhookResult: a.string(),
      updatedBy: a.string(),
    })
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read"]),
      allow.group("VIEWER").to(["read"]),
    ]),

  /**
   * 過去にBASEへ掲載した商品のアーカイブ。
   *
   * 【なぜ別モデルなのか】既存の `BaseItemCache` は特集ページを描画する
   * ための読み取りキャッシュで、載せる商品だけを短期間持つもの。
   * こちらは**文体分析と類似商品参照のための蓄積**で、目的も寿命も違う。
   * 同じ表に混ぜると、特集ページのキャッシュ掃除が分析用の母集団を
   * 消してしまう。
   *
   * 再同期で重複を作らないよう、識別子はBASEのitem_idそのもの。
   * 元の説明文(detailRaw)は書き換えず、分析に使う正規化テキストは
   * 別フィールドに持つ(§2「元データを勝手に書き換えず」)。
   */
  BaseProductArchive: a
    .model({
      baseItemId: a.string().required(),
      title: a.string().required(),
      /** BASEから受け取ったままの説明文(HTML等を含む)。加工しない。 */
      detailRaw: a.string(),
      /** 分析用に正規化した平文。 */
      detailText: a.string(),
      /** 抽出した「◎商品のご紹介」本文(取れなかった場合はnull)。 */
      introText: a.string(),
      /** セクション分解の結果(JSON文字列)。見出し→本文。 */
      sectionsJson: a.string(),
      price: a.integer(),
      properPrice: a.integer(),
      stock: a.integer(),
      visible: a.boolean(),
      /** BASE側の最終更新(unix秒をISOへ変換したもの)。取得期間の算出に使う。 */
      modifiedAt: a.datetime(),
      /** 画像URLの配列(JSON文字列)。 */
      imageUrlsJson: a.string(),
      variationsJson: a.string(),
      itemUrl: a.string(),
      /** 商品名から機械的に導いたブランド候補(JSON配列)。推測した事実ではなく検索用の手がかり。 */
      brandHintsJson: a.string(),
      /** 検索用に正規化した商品名(社内マーカー・検索語ノイズを落としたもの)。 */
      titleCore: a.string(),
      syncedAt: a.datetime().required(),
    })
    .identifier(["baseItemId"])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("Admins"),
      allow.group("EDITOR").to(["read"]),
      allow.group("VIEWER").to(["read"]),
    ]),

  /**
   * BELLO Style Profile。過去BASE説明文の全体分析結果を、versionを付けて残す。
   *
   * 【なぜversionを持つのか】文体は商品が増えれば変わるし、分析の仕方も
   * 変わる。上書きしてしまうと「いつの分析でこの文章が生成されたのか」が
   * 追えなくなる。生成物(GeneratedProductPage)がversionを参照するので、
   * 後から突き合わせられる。
   */
  BelloStyleProfile: a
    .model({
      version: a.integer().required(),
      /** AIが参照するのは isActive=true の1件だけ。 */
      isActive: a.boolean().default(false),
      analyzedItemCount: a.integer().required(),
      analysisPeriodStart: a.datetime(),
      analysisPeriodEnd: a.datetime(),
      /** 分析結果そのもの(JSON文字列)。lib/ai/productIntro/styleProfile.tsの型。 */
      profileJson: a.string().required(),
      /** 分析の確からしさ(サンプル数から機械的に導く)。 */
      confidence: a.float(),
      generatedAt: a.datetime().required(),
      generatedBy: a.string(),
    })
    // GSIは張らない。booleanはDynamoDBのキーに使えず、そのためだけに
    // 文字列フラグを増やすほどの行数ではない(分析を回した回数ぶんしか
    // 増えず、実運用でも数十行の桁)。読み出しは全件取得して
    // isActive で絞る —— この表に限っては全件取得が正しい選択。
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read"]),
      allow.group("VIEWER").to(["read"]),
    ]),

  /**
   * 売上の月次集計(2026-09-02 指示書§15〜§20)。
   *
   * **派生データ**。正本は今までどおり Inventory で、この表はいつでも
   * 捨てて作り直せる。加算していく設計にしていないのは、加算はイベントを
   * 1つ取りこぼしただけで静かにズレ、しかも気づけないから。対象月の
   * レコードから毎回作り直すので、二重計上も取消の取りこぼしも起きない。
   *
   * identifier を yearMonth にしてあるので、月を指定した読み出しは
   * Scan ではなく GetItem 1回で済む。
   */
  SalesMonthlyAggregate: a
    .model({
      /** "2026-09" 形式。集計の単位であり主キー。 */
      yearMonth: a.string().required(),
      count: a.integer().required(),
      totalSales: a.integer().required(),
      totalPurchase: a.integer().required(),
      totalShipping: a.integer().required(),
      totalCost: a.integer().required(),
      totalProfit: a.integer().required(),
      /** 何件の在庫レコードから作ったか(母集団の大きさ)。 */
      sourceRecordCount: a.integer(),
      /** いつ作り直したか。画面に「○○時点の集計」と出すため。 */
      rebuiltAt: a.datetime().required(),
      rebuiltBy: a.string(),
    })
    .identifier(["yearMonth"])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR"),
      allow.group("VIEWER").to(["read"]),
    ]),

  /**
   * BELLO改善指示(Human Editorial Guidance)。
   *
   * 2026-09-02 追加仕様§4/§5: 「過去BASE実績から抽出した Style Profile」と
   * 「担当者が書いた改善要望」を**混ぜて上書きしない**。前者は
   * BelloStyleProfile(機械が数えた結果)、後者がこのモデル(人が書いた指示)。
   *
   * 生成時の優先順位:
   *   Inventory等の確定事実 > BELLO改善指示 > Style Profile >
   *   類似BASE商品 > 一般的なAI表現
   *
   * ただし改善指示で**商品の事実を変えることはできない** —— 事実の検査
   * (factSafety)は改善指示より後段にあり、指示の内容に関わらず効く。
   */
  ProductDescriptionGuidance: a
    .model({
      /** 自然文の指示(例:「商品のご紹介にはサイズを書かない」)。 */
      instruction: a.string().required(),
      /**
       * 有効/無効。削除より無効化を優先する(追加仕様§6) ——
       * 過去に生成した文章が「どの指示のもとで作られたか」を後から
       * 追えなくなるため。
       */
      enabled: a.boolean().default(true),
      /** 並び順。小さいほど先に効く(競合したときに人が順序で解決できる)。 */
      sortOrder: a.integer().default(0),
      /** この指示自体の版。編集のたびに増える。 */
      version: a.integer().default(1),
      createdBy: a.string(),
      updatedBy: a.string(),
    })
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read"]),
      allow.group("VIEWER").to(["read"]),
    ]),

  /**
   * 商品説明設定のversion履歴(追加仕様§9)。
   *
   * 「いつ・誰が・どのStyle Profile版と、どの改善指示の組み合わせを
   * ACTIVEにしたか」を残す。復元は過去versionを書き換えるのではなく、
   * **その内容で新しいversionを作ってACTIVEにする** —— 履歴が枝分かれ
   * しないようにするため(ナレッジ文書の復元と同じ考え方)。
   */
  ProductDescriptionSettingVersion: a
    .model({
      version: a.integer().required(),
      activatedAt: a.datetime().required(),
      activatedBy: a.string(),
      /** このversionで参照していた BelloStyleProfile の version。 */
      styleProfileVersion: a.integer(),
      /** そのときの改善指示のスナップショット(JSON配列)。 */
      guidanceSnapshotJson: a.string(),
      /** 生成設定(将来の拡張用。現状は空オブジェクト)。 */
      generationConfigJson: a.string(),
      /** 変更の理由。人が書く。 */
      note: a.string(),
      /** 現在有効な1件。 */
      isActive: a.boolean().default(false),
      /** 復元で作られた版なら、その元のversion。 */
      restoredFromVersion: a.integer(),
    })
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read"]),
      allow.group("VIEWER").to(["read"]),
    ]),

  /**
   * 在庫から生成した商品ページ。単一の文章ではなくセクションごとに持つ
   * (§10「在庫登録→写真加工→情報補完→商品ページ生成→人間確認→出品」
   * へつなぐため、後段が必要な部分だけを差し替えられる形にする)。
   */
  GeneratedProductPage: a
    .model({
      inventoryId: a.string().required(),
      title: a.string(),
      introduction: a.string(),
      brandSection: a.string(),
      designerSection: a.string(),
      featureSection: a.string(),
      materialSection: a.string(),
      dimensionsSection: a.string(),
      conditionSection: a.string(),
      shippingSection: a.string(),
      fullDescription: a.string(),
      styleProfileVersion: a.integer(),
      /** 参照した過去BASE商品のID(JSON配列)。事実の出所を後から追えるようにする。 */
      referencedBaseItemIdsJson: a.string(),
      /** 生成後の検査結果(JSON)。事実の裏付けが無い記述を検出した内容。 */
      validationJson: a.string(),
      /** 在庫に情報が無く、人の入力を待っている項目(JSON配列)。推測で埋めない。 */
      missingFactsJson: a.string(),
      modelProvider: a.string(),
      modelName: a.string(),
      generatedAt: a.datetime().required(),
      generatedBy: a.string(),
    })
    .secondaryIndexes((index) => [index("inventoryId")])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR"),
      allow.group("VIEWER").to(["read"]),
    ]),

  /**
   * ナレッジ文書の版。誤編集から戻せるようにするためのもの。
   *
   * 【なぜKnowledgeDocumentを二重に持たないか】正本はあくまで
   * KnowledgeDocument。ここに入るのは**保存前の中身**(つまり1つ前の状態)
   * で、AIは決してこちらを参照しない。復元も「この行の中身で正本を
   * 上書きする」新しい更新として扱うので、履歴が枝分かれしない。
   */
  KnowledgeDocumentRevision: a
    .model({
      documentId: a.string().required(),
      /** その版が「KnowledgeDocument.version がいくつだったときの中身か」。 */
      version: a.integer().required(),
      title: a.string(),
      body: a.string(),
      /** MANUAL_EDIT / RESTORE のいずれか。復元自体も1つの変更として残す。 */
      changeType: a.string(),
      /** 復元の場合、どの版から戻したか。 */
      restoredFromVersion: a.integer(),
      changedBy: a.string(),
      changedAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [index("documentId")])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read"]),
      allow.group("VIEWER").to(["read"]),
    ]),

  ExternalResearchStatus: a.enum(["FOUND", "NOT_FOUND", "CONFLICT", "UNCERTAIN"]),

  /**
   * §20 外部Webリサーチ結果のキャッシュ。同じ商品の同じ項目を何度も
   * 調べ直さないため。
   *
   * cacheKeyは「対象商品の識別子 + 調べた項目」から作る決定的な文字列
   * (lib/inquiry/research/cache.tsのbuildResearchCacheKey)。価格・在庫の
   * ような変動情報は短いTTL、公式仕様・寸法は長いTTL —— TTLはfieldの
   * 種類から決まるので、ここには「いつ取得したか」だけを持ち、有効期限の
   * 判断は読み出し側で行う(TTL方針を変えても既存行を書き換えずに済む)。
   */
  ExternalResearchCache: a
    .model({
      cacheKey: a.string().required(),
      field: a.string().required(),
      value: a.string(),
      status: a.ref("ExternalResearchStatus").required(),
      sourceTitle: a.string(),
      sourceUrl: a.string(),
      sourceType: a.string(),
      confidence: a.float(),
      fetchedAt: a.datetime().required(),
    })
    .identifier(["cacheKey"])
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR"),
      allow.group("VIEWER").to(["read"]),
    ]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "apiKey",
    apiKeyAuthorizationMode: { expiresInDays: 30 },
  },
});
