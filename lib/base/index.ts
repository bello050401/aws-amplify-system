import type { BaseApiClient } from "./client";
import { MockBaseApiClient } from "./client.mock";
import { RealBaseApiClient } from "./client.real";
import { hasBaseAppCredentials, isBaseMockForced, isProductionRuntime, shouldUseBaseMock } from "./connectionState";

export type { BaseApiClient } from "./client";
export { BaseApiError } from "./client";
export * from "./types";

let instance: BaseApiClient | null = null;

/**
 * 設定不備でBASEを呼べないことを表すエラー。呼び出し側(Server Action)は
 * これを捕まえて、利用者に分かる日本語で表示する。
 */
export class BaseNotConfiguredError extends Error {
  constructor() {
    super(
      "BASE APIのアプリ認証情報（BASE_CLIENT_ID / BASE_CLIENT_SECRET）が設定されていないため、BASEの商品を取得できません。",
    );
    this.name = "BaseNotConfiguredError";
  }
}

/**
 * Single entry point every route/component should import instead of
 * reaching for MockBaseApiClient / RealBaseApiClient directly.
 *
 * ## 2026-09-01: 本番でモックへ落ちる経路を塞いだ
 *
 * 以前は `BASE_CLIENT_ID` / `BASE_CLIENT_SECRET` が未設定なら、
 * **どの環境でも** console.warn だけ出してモックへフォールバックして
 * いた。モックが返すのは `lib/base/fixtures.ts` の作り物の商品
 * (vitra Softshell、Cassina、HAY、USM、Artek 等)である。
 *
 * 実測: Staging(Amplifyアプリ `bello-inventory-staging`)には
 * アプリ側・ブランチ側のどちらにもこの2つの環境変数が設定されておらず、
 * `BaseOAuthToken` の行数も0だった。つまり **本番相当の環境で、管理画面の
 * BASE商品検索は作り物の商品を実在の商品として返していた** ——
 * そのまま特集ページを作れば、存在しない商品が載ったページを公開し得る。
 *
 * デモ用の便利機能が、本番で「嘘のデータを黙って返す」経路になっていた
 * (§6.1のsilent failure)。モックは明示的なopt-in
 * (`BASE_USE_MOCK=true`)か、本番ビルドでないローカル開発に限る。
 */
export function getBaseClient(): BaseApiClient {
  if (!instance) {
    if (shouldUseBaseMock()) {
      if (!isBaseMockForced()) {
        console.warn("[lib/base] BASE_CLIENT_ID / BASE_CLIENT_SECRET is not set — falling back to the mock BASE client (development only).");
      }
      instance = new MockBaseApiClient();
    } else if (!hasBaseAppCredentials()) {
      // 本番で認証情報が無い場合。作り物を返さずに、設定不備として失敗する。
      throw new BaseNotConfiguredError();
    } else {
      instance = new RealBaseApiClient();
    }
  }
  return instance;
}

/**
 * テスト用: モジュールスコープのキャッシュを捨てる。環境変数を変えながら
 * getBaseClient()の分岐を検証するために必要(本番経路では呼ばれない)。
 */
export function resetBaseClientForTests(): void {
  instance = null;
}

export { isProductionRuntime };
