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

  // Named custom type (not a model — no table of its own) for the images
  // embedded on Inventory. Images are always read/written together with
  // their parent Inventory record and never queried independently, so an
  // embedded list keeps this to one DynamoDB item instead of a second
  // table + relation just to hold a handful of S3 keys. `sortOrder`
  // determines display order; index 0 is the main image (per spec §6 —
  // no separate `isMain` flag needed, "set as main image" is just
  // reordering to the front).
  InventoryImage: a.customType({
    storageKey: a.string().required(), // S3 key under the `inventory/` prefix — see amplify/storage/resource.ts
    sortOrder: a.integer().required(),
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
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "apiKey",
    apiKeyAuthorizationMode: { expiresInDays: 30 },
  },
});
