import { isBaseConnected } from "./oauth";
import { getBaseCredentialsState, type BaseCredentialsSource } from "./secretStore";
import { buildRedirectUriFromHost } from "./redirectUri";
import { isExternalWriteEnabled } from "@/lib/integrations/writeGuard";

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

/**
 * 商品データが実際にどこから来るか。
 *
 * 【2026-09-01 UI E2Eで発見】以前は `usingRealApi: boolean` の2値しか
 * 持っておらず、設定画面は false のとき一律に
 * 「開発用のモックデータ（実在しない商品）」と表示していた。
 * ところが本番では認証情報が無いとモックへ落ちず
 * `BaseNotConfiguredError` で失敗する(lib/base/index.ts)ため、
 * **実際にはモックすら返らないのに「モックデータを使用中」と表示される**
 * という食い違いが起きていた。実画面を見て初めて分かった不整合。
 *
 * 3値にして、表示と実挙動を一致させる。
 */
export type BaseDataSource = "REAL" | "MOCK" | "UNAVAILABLE";

export interface BaseConnectionState {
  status: BaseConnectionStatus;
  /** 実際のBASE APIを呼ぶ構成になっているか(モックならfalse)。 */
  usingRealApi: boolean;
  /** 商品データの取得元。UIはこれを表示する。 */
  dataSource: BaseDataSource;
  /** Client ID / Secret が両方設定されているか。値そのものは返さない。 */
  hasAppCredentials: boolean;
  /**
   * 認証情報がどこから来ているか。設定画面の案内を変えるために要る ——
   * 環境変数由来の場合、画面から上書き保存はできるがAWS側の環境変数が
   * 残り続けるので、その旨を伝える必要がある。
   */
  credentialsSource: BaseCredentialsSource;
  /** 保存済みのClient ID。**秘匿値ではない**ので、設定済みの確認用に表示してよい。Secretは決して返さない。 */
  clientId: string | null;
  /** 認可時に `write_items` まで要求する設定になっているか。 */
  requestWriteItems: boolean;
  /** 誰がいつ登録したか(監査用)。値は含まない。 */
  credentialsUpdatedAt: string | null;
  credentialsUpdatedBy: string | null;
  /** BASE Developersへ登録すべきコールバックURL。画面でコピーさせる。 */
  redirectUri: string | null;
  /**
   * BASEへの書き込み（出品・価格変更）が許可されているか。
   * 既定は禁止で、AWS側の環境変数でのみ開く（lib/integrations/writeGuard.ts）。
   * 画面には状態を表示するだけで、ここから変更はできない。
   */
  writesEnabled: boolean;
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

/**
 * 環境変数だけを見る同期版。**モックへ落ちてよいかの判定にだけ使う。**
 *
 * 認証情報の本当の所在はSecrets Manager（lib/base/secretStore.ts）で、
 * それを読むのは非同期。`getBaseClient()` は各所から同期に呼ばれている
 * ため、そこでSecrets Managerを待つことはできない。
 * 幸いこの関数が必要なのは「本番でないローカル開発で、環境変数が無い
 * ときにモックを使ってよいか」の判定だけで、本番の分岐には関与しない。
 */
export function hasBaseAppCredentialsInEnv(): boolean {
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
  if (hasBaseAppCredentialsInEnv()) return false;
  // ローカル開発でのみ、認証情報なしでもモックで動かせる。
  return !isProductionRuntime();
}

/**
 * @param host 設定画面を開いているブラウザから見たホスト名。
 *   BASE Developersへ登録すべきコールバックURLを組み立てるためだけに使う。
 *   渡されなければ redirectUri は null になり、画面は環境変数側の値を案内する。
 */
export async function getBaseConnectionState(host?: string | null): Promise<BaseConnectionState> {
  const credentials = await getBaseCredentialsState();
  const hasAppCredentials = credentials.source !== "unconfigured";
  const redirectUri = buildRedirectUriFromHost(host ?? null);

  /** 全分岐で共通の、秘匿値を含まない部分。 */
  const base = {
    credentialsSource: credentials.source,
    clientId: credentials.clientId,
    requestWriteItems: credentials.requestWriteItems,
    credentialsUpdatedAt: credentials.updatedAt,
    credentialsUpdatedBy: credentials.updatedBy,
    redirectUri,
    writesEnabled: isExternalWriteEnabled("BASE"),
  };

  if (isBaseMockForced()) {
    return {
      ...base,
      status: "MOCK",
      usingRealApi: false,
      dataSource: "MOCK",
      hasAppCredentials,
      hasOAuthToken: false,
      message: "開発用のモックデータを使う設定になっています（BASE_USE_MOCK=true）。実際のBASEの商品は表示されません。",
      checkError: null,
    };
  }

  if (!hasAppCredentials) {
    return {
      ...base,
      status: "NOT_CONFIGURED",
      usingRealApi: false,
      // 本番では getBaseClient() がモックへ落ちずに失敗する。
      dataSource: isProductionRuntime() ? "UNAVAILABLE" : "MOCK",
      hasAppCredentials: false,
      hasOAuthToken: false,
      message: isProductionRuntime()
        ? "BASE APIのアプリ認証情報（Client ID / Client Secret）が未登録です。下のフォームから登録してください。"
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
      ...base,
      status: "CREDENTIALS_ONLY",
      usingRealApi: true,
      dataSource: "UNAVAILABLE",
      hasAppCredentials: true,
      hasOAuthToken: false,
      message: "BASEの接続状態を確認できませんでした。",
      checkError: "接続状態の確認に失敗しました。時間をおいて再度お試しください。",
    };
  }

  if (!hasOAuthToken) {
    return {
      ...base,
      status: "CREDENTIALS_ONLY",
      usingRealApi: true,
      // 認証情報はあるがOAuth未完了 —— 実際の取得は BaseNotConnectedError になる。
      dataSource: "UNAVAILABLE",
      hasAppCredentials: true,
      hasOAuthToken: false,
      message: "アプリ認証情報は設定済みです。次に「BASEアカウントを連携する」を実行してください（BASEアカウント所有者本人の承認が必要です）。",
      checkError: null,
    };
  }

  return {
    ...base,
    status: "CONNECTED",
    usingRealApi: true,
    dataSource: "REAL",
    hasAppCredentials: true,
    hasOAuthToken: true,
    message: "接続済み。特集ページ作成機能と商品説明分析機能は、この同じ接続を共用します（認証情報はサーバー側にのみ保存されています）。",
    checkError: null,
  };
}
