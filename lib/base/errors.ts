/**
 * BASE連携のエラー型だけを置く小さなモジュール。
 *
 * `BaseNotConfiguredError` は元々 lib/base/index.ts にあったが、
 * 認証情報の解決がSecrets Manager経由（非同期）になったことで
 * oauth.ts からも投げる必要が出た。index.ts は connectionState.ts →
 * oauth.ts をimportしているので、oauth.ts が index.ts をimportすると
 * 循環する。エラー型だけを独立させて両方から参照できるようにする。
 */
export class BaseNotConfiguredError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "BASE APIのアプリ認証情報（Client ID / Client Secret）が設定されていないため、BASEの商品を取得できません。設定画面の「BASE連携」タブから登録してください。",
    );
    this.name = "BaseNotConfiguredError";
  }
}
