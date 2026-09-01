import type { BaseApiClient } from "./client";
import { MockBaseApiClient } from "./client.mock";
import { RealBaseApiClient } from "./client.real";
import { isBaseMockForced, isProductionRuntime, shouldUseBaseMock } from "./connectionState";

export type { BaseApiClient } from "./client";
export { BaseApiError } from "./client";
export * from "./types";

let instance: BaseApiClient | null = null;

/**
 * 設定不備でBASEを呼べないことを表すエラー。呼び出し側(Server Action)は
 * これを捕まえて、利用者に分かる日本語で表示する。
 *
 * 定義そのものは lib/base/errors.ts へ移した —— 認証情報の解決が
 * Secrets Manager経由（非同期）になり、oauth.ts からも投げる必要が
 * 出たため（index.ts をimportすると循環する）。
 */
export { BaseNotConfiguredError } from "./errors";

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
        console.warn("[lib/base] BASE credentials are not set — falling back to the mock BASE client (development only).");
      }
      instance = new MockBaseApiClient();
    } else {
      // 認証情報の有無はここでは判定しない。Secrets Managerからの読み出しは
      // 非同期で、この関数は同期のまま各所から呼ばれているため。
      // 未設定の場合は RealBaseApiClient が最初のAPI呼び出しで
      // getAccessToken() → BaseNotConfiguredError を投げる（lib/base/oauth.ts）。
      // 大事なのは「作り物の商品を黙って返さない」ことで、それはここで
      // モックを選ばないことによって守られている。
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
