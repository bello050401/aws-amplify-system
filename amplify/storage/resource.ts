import { defineStorage } from "@aws-amplify/backend";

/**
 * 在庫商品の画像を保存するS3バケット定義。
 * PC版・モバイル版は同一バケット/同一キー規則(items/{itemId}/...)を共有する。
 * モバイル専用のコピーストレージは作らない(指示書 §24, §27)。
 */
export const storage = defineStorage({
  name: "belloInventoryStorage",
  access: (allow) => ({
    "items/*": [
      allow.authenticated.to(["read", "write", "delete"]),
    ],
  }),
});
