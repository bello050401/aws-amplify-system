import { isBaseConnected } from "./oauth";

/**
 * BASE APIの接続状態を、設定画面が「正直に」表示できる形へまとめる
 * (夜間統合指示書 2026-09-01 §4.2 / §6.1)。
 *
 * ## なぜ必要か —— 実測で見つかった問題
 *
 * `getBaseClient()` は `BASE_CLIENT_ID` / `BASE_CLIENT_SECRET` が
 * 未設定だと **console.warn だけ出してモッククライアントへフォールバック**
 * していた。モックは `lib/base/fixtures.ts` の作り物の商品
 * (vitra Softshell、Cassina、HAY、USM、Artek 等、いかにもBELLOに
 * ありそうな商品)を返す。
 *
 * 2026-09-01時点のStaging(Amplifyアプリ `bello-inventory-staging`)には
 * アプリ側・ブランチ側のどちらにも `BASE_CLIENT_ID` /
 * `BASE_CLIENT_SECRET` が設定されておらず、`BaseOAuthToken` テーブルの
 * 行数も0だった。つまり **本番相当の環境で、管理画面のBASE商品検索は
 * 作り物の商品を実在の商品として返していた**。そのまま特集ページを
 * 作れば、存在しない商品が載ったページが公開され得る。
 *
 * これは§6.1が名指しする silent failure そのもの。デモ用の便利機能が、
 * 本番で「嘘のデータを黙って返す」経路になっていた。
 *
 * ## 方針
 *
 * - モックを使うのは **明示的にopt-inした場合** (`BASE_USE_MOCK=true`)か、
 *   **本番ビルドでないローカル開発**で認証情報が無い場合だけ。
 * - 本番で認証情報が無ければ、作り物を返さずに **設定不備として失敗する**。
 * - 状態は設定画面がそのまま表示できる形で返す(秘密値は一切含めない)。
 */

export type BaseConnectionStatus =
  /** OAuth接続済み。実データを読める。 */
  | "CONNECTED"
  /** アプリ認証情報(Client ID/Secret)はあるが、OAuth連携がまだ。 */
  | "CREDENTIALS_ONLY"
  /** Client ID/Secretが未設定。 */
  | "NOT_CONFIGURED"
  /** 明示的にモックを使う設定になっている(開発用)。 */
  | "MOCK";

export interface BaseConnectionState {
  status: BaseConnectionStatus;
  /** 実際のBASE APIを呼ぶ構成になっているか(モックならfalse)。 */
  usingRealApi: boolean;
  /** Client ID / Secret が両方設定されているか。値そのものは返さない。 */
  hasAppCredentials: boolean;
  /** OAuthトークンが保存されているか。 */
  hasOAuthToken: boolean;
  /** 設定画面に出す日本語の説明。 */
  message: string;
  /** 状態の確認自体に失敗した場合の説明(権限不足等)。nullでなければ「未接続」と断定してはいけない。 */
  checkError: string | null;
}

/** 本番ビルドかどうか。Amplify HostingのSSRコンピュート上ではproductionになる。 */
export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

export function hasBaseAppCredentials(): boolean {
  return Boolean(process.env.BASE_CLIENT_ID?.trim() && process.env.BASE_CLIENT_SECRET?.trim());
}

export function isBaseMockForced(): boolean {
  return process.env.BASE_USE_MOCK === "true";
}

/**
 * モックへフォールバックしてよいか。
 * 本番では「明示的にopt-inした場合」以外は絶対に許さない —— 作り物の商品を
 * 実在の商品として返すことになるため。
 */
export function shouldUseBaseMock(): boolean {
  if (isBaseMockForced()) return true;
  if (hasBaseAppCredentials()) return false;
  // ローカル開発でのみ、認証情報なしでもモックで動かせる。
  return !isProductionRuntime();
}

export async function getBaseConnectionState(): Promise<BaseConnectionState> {
  const hasAppCredentials = hasBaseAppCredentials();

  if (isBaseMockForced()) {
    return {
      status: "MOCK",
      usingRealApi: false,
      hasAppCredentials,
      hasOAuthToken: false,
      message: "開発用のモックデータを使う設定になっています（BASE_USE_MOCK=true）。実際のBASEの商品は表示されません。",
      checkError: null,
    };
  }

  if (!hasAppCredentials) {
    return {
      status: "NOT_CONFIGURED",
      usingRealApi: false,
      hasAppCredentials: false,
      hasOAuthToken: false,
      message: isProductionRuntime()
        ? "BASE APIのアプリ認証情報（BASE_CLIENT_ID / BASE_CLIENT_SECRET）が設定されていません。BASE連携機能は利用できません。"
        : "BASE APIのアプリ認証情報が未設定のため、開発用のモックデータで動作しています（本番では無効です）。",
      checkError: null,
    };
  }

  let hasOAuthToken = false;
  try {
    hasOAuthToken = await isBaseConnected();
  } catch (err) {
    // §6.1: 確認できなかったことを「未接続」と偽らない。
    console.error("[getBaseConnectionState] failed to read the BASE OAuth token:", err instanceof Error ? err.message : String(err));
    return {
      status: "CREDENTIALS_ONLY",
      usingRealApi: true,
      hasAppCredentials: true,
      hasOAuthToken: false,
      message: "BASEの接続状態を確認できませんでした。",
      checkError: "接続状態の確認に失敗しました。時間をおいて再度お試しください。",
    };
  }

  if (!hasOAuthToken) {
    return {
      status: "CREDENTIALS_ONLY",
      usingRealApi: true,
      hasAppCredentials: true,
      hasOAuthToken: false,
      message: "BASEアプリの認証情報は設定済みですが、BASEアカウントとの連携（OAuth認可）がまだ完了していません。",
      checkError: null,
    };
  }

  return {
    status: "CONNECTED",
    usingRealApi: true,
    hasAppCredentials: true,
    hasOAuthToken: true,
    message: "接続済み（既存のBASE特集ページ連携設定を使用）。認証情報はサーバー側にのみ保存されています。",
    checkError: null,
  };
}
