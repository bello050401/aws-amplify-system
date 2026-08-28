import { defineAuth } from "@aws-amplify/backend";

/**
 * BELLO在庫管理システム 認証定義 (Amazon Cognito)
 *
 * PC版・iPhone/PWA版はこの同一Cognito User Poolを共有する。
 * モバイル版だけ認証をバイパスしない(指示書 §25)。
 *
 * グループ:
 *  - Admins: 削除等の破壊的操作が可能
 *  - Staff : 通常の在庫操作(検索/編集/入出庫/棚卸/一括操作)が可能
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  groups: ["Admins", "Staff"],
  userAttributes: {
    // 変更履歴の「最終更新者」表示に使う表示名
    givenName: {
      mutable: true,
      required: false,
    },
  },
});
