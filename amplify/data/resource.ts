import { a, defineData, type ClientSchema } from "@aws-amplify/backend";

/**
 * BELLO在庫管理システム データモデル定義 (AWS AppSync + Amazon DynamoDB)
 *
 * PC版・iPhone/PWA版は同一のこのスキーマ・同一API・同一データを利用する。
 * モバイル専用の複製データモデルは作らない(指示書 §24)。
 *
 * 命名は指示書 §11 のBELLO独自カスタム項目にあわせている。
 */
const schema = a.schema({
  // ---------------------------------------------------------------------
  // カテゴリ (フラット管理。指示書 §14: 既存がフラットなら階層UIを追加しない)
  // ---------------------------------------------------------------------
  Category: a
    .model({
      name: a.string().required(),
      sortOrder: a.integer().default(0),
      items: a.hasMany("Item", "categoryId"),
    })
    .authorization((allow) => [allow.authenticated()]),

  // ---------------------------------------------------------------------
  // 保管場所
  // ---------------------------------------------------------------------
  Location: a
    .model({
      name: a.string().required(),
      code: a.string(),
      items: a.hasMany("Item", "locationId"),
    })
    .authorization((allow) => [allow.authenticated()]),

  // ---------------------------------------------------------------------
  // 在庫物品本体
  // ---------------------------------------------------------------------
  Item: a
    .model({
      // 基本項目
      name: a.string().required(),
      barcode: a.string(), // QRコード・バーコードの値
      quantity: a.float().default(0),
      freeQuantity: a.float().default(0), // フリー数
      reorderPoint: a.float(), // 発注点
      unit: a.string().default("個"),
      status: a.string(), // 出品待ち / 入金待ち / 販売中 等
      notes: a.string(), // 備考(長文)

      categoryId: a.id(),
      category: a.belongsTo("Category", "categoryId"),
      locationId: a.id(),
      location: a.belongsTo("Location", "locationId"),

      // 画像
      thumbnailKey: a.string(),
      imageKeys: a.string().array(),

      // BELLO独自カスタム項目 (指示書 §11)
      plannedPrice: a.float(), // ☆販売予定価格(送料別・記載)
      discountPrice30: a.float(), // 1回目値下げ(30日)
      discountPrice60: a.float(), // 2回目値下げ(60日)
      discountPrice90: a.float(), // 3回目値下げ(90日)
      condition: a.integer(), // コンディション評価 1〜5
      damageNotes: a.string(), // 傷汚れ箇所等メモ
      widthCm: a.float(),
      depthCm: a.float(),
      heightCm: a.float(),
      lengthCm: a.float(),
      householdCategory: a.string(), // 家財区分
      itemType: a.string(), // 品目
      transactionDate: a.date(), // 取引の年月日
      antiqueFeature: a.string(), // 古物の特徴
      stocktakeDate: a.date(), // 棚卸日

      // 運用メタ情報
      isDeleted: a.boolean().default(false), // 論理削除
      version: a.integer().default(1), // 楽観ロック用バージョン
      userGroup: a.string(), // 所属ユーザーグループ
      updatedBy: a.string(),
      createdBy: a.string(),

      movements: a.hasMany("StockMovement", "itemId"),
      histories: a.hasMany("ItemHistory", "itemId"),
    })
    .secondaryIndexes((index) => [
      index("barcode"),
      index("categoryId"),
      index("locationId"),
    ])
    .authorization((allow) => [
      allow.authenticated().to(["read", "create", "update"]),
      allow.groups(["Admins"]).to(["read", "create", "update", "delete"]),
    ]),

  // ---------------------------------------------------------------------
  // 入庫/出庫/移動/棚卸 履歴 (数量変動の唯一の記録元)
  // ---------------------------------------------------------------------
  StockMovement: a
    .model({
      itemId: a.id().required(),
      item: a.belongsTo("Item", "itemId"),
      type: a.enum(["RECEIVE", "SHIP", "MOVE", "ADJUST", "STOCKTAKE"]),
      quantity: a.float().required(),
      fromLocationId: a.id(),
      toLocationId: a.id(),
      note: a.string(),
      operatorId: a.string(),
      operatorName: a.string(),
    })
    .secondaryIndexes((index) => [index("itemId")])
    .authorization((allow) => [allow.authenticated()]),

  // ---------------------------------------------------------------------
  // 変更履歴 (物品詳細の「変更履歴」ボタンから参照)
  // ---------------------------------------------------------------------
  ItemHistory: a
    .model({
      itemId: a.id().required(),
      item: a.belongsTo("Item", "itemId"),
      action: a.enum(["CREATE", "UPDATE", "DELETE", "DUPLICATE"]),
      changesJson: a.string(), // [{field, oldValue, newValue}] のJSON文字列
      changedBy: a.string(),
    })
    .secondaryIndexes((index) => [index("itemId")])
    .authorization((allow) => [allow.authenticated()]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
  },
});
