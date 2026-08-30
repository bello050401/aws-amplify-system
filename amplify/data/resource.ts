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

  // BASE OAuth2 tokens for this shop's connected app. Admins-only, no
  // public rule at all — unlike the models above, this is a credential,
  // not display data. There is exactly one row (id: "singleton"). Written
  // by the OAuth callback route (has the connecting admin's session) and
  // refreshed by lib/base/oauth.ts, always from an admin-authenticated
  // request context (see BaseItemCache comment above for why that's true
  // of every caller of the BASE API client in this system).
  BaseOAuthToken: a
    .model({
      accessToken: a.string().required(),
      refreshToken: a.string().required(),
      expiresAt: a.datetime().required(),
      updatedAt: a.datetime().required(),
    })
    .authorization((allow) => [allow.group("Admins")]),

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
      sourceInventoryId: a.string(),
    })
    .secondaryIndexes((index) => [
      index("sku"), // search + pre-create duplicate-check (see §6 below on exact guarantees)
      index("categoryId"),
      index("statusId"),
      index("locationId"),
      index("deletedAt"),
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
    })
    .authorization((allow) => [
      allow.group("ADMIN"),
      allow.group("EDITOR").to(["read"]), // visibility only — starting/cancelling/advancing a background sync is an ADMIN action, same boundary as the synchronous sync Server Actions
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
  ListingChannel: a.enum(["MERCARI_SHOPS"]), // 現時点でMercari Shopsのみ。将来チャネル追加時はここへ値を足すだけ

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
    })
    .secondaryIndexes((index) => [index("inventoryId"), index("listingDraftId")])
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
