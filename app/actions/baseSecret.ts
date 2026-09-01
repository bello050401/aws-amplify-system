"use server";

import { revalidatePath } from "next/cache";
import { getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { deleteBaseCredentials, saveBaseCredentials } from "@/lib/base/secretStore";
import { getBaseClient } from "@/lib/base";
import { BaseNotConfiguredError } from "@/lib/base/errors";
import { BaseApiError } from "@/lib/base/client";
import { BaseNotConnectedError, disconnectBase } from "@/lib/base/oauth";

/**
 * BASEアプリ認証情報（Client ID / Client Secret）の登録・削除と、接続テスト。
 *
 * ## なぜServer Actionなのか —— 「ブラウザからAWS Secretsを直接変更できる
 * 設計は禁止」への答え
 *
 * ブラウザは **AWSの認証情報を一切持たない**。入力値はServer Actionの
 * 引数としてサーバーへ渡り、Secrets Managerを実際に書くのはAmplify
 * HostingのSSR実行ロール(`BelloAmplifyStagingComputeRole`)である。
 * そのロールに与えたのは、**この1本のSecretに対する
 * GetSecretValue / PutSecretValue だけ** ——
 * `CreateSecret` も、他のSecretへのアクセスも与えていない
 * (Secret自体はAWS CLIで事前に作成済み)。
 * 管理画面に「強い権限」が付かないのはこのためで、
 * 万一この経路が悪用されても、影響範囲はBASEのアプリ認証情報1件に閉じる。
 *
 * ZAICO・Mercari・LINEで既に使っている方式と同一で、新しい仕組みを
 * 増やしていない。
 *
 * ## 秘密値の扱い
 *
 * - Client Secretは**保存後に一切読み出して返さない**(secretStore.tsの
 *   getBaseCredentialsState はSecretを返さない設計)。
 * - 戻り値・エラーメッセージ・ログのどこにもSecretを載せない。
 * - `NEXT_PUBLIC_` 系の公開環境変数は使わない。
 * - Amplify Data(ブラウザから読めるDB)にも保存しない。
 *
 * ## 例外を投げない契約
 *
 * app/actions/mercariSecret.ts と同じ理由 —— production buildでは
 * Server Actionからthrowされたmessageが英語の定型文へ丸められ、
 * 利用者には何が起きたか分からなくなる。必ず判別可能な結果オブジェクトを返す。
 */

export type BaseSecretActionResult =
  | { success: true; message: string }
  | { success: false; message: string; retryable: boolean };

async function requireAdmin(): Promise<BaseSecretActionResult | null> {
  const role = await getInventoryRole();
  if (role !== "ADMIN") {
    return { success: false, message: "この操作にはADMIN権限が必要です。", retryable: false };
  }
  return null;
}

export async function saveBaseCredentialsAction(params: {
  clientId: string;
  clientSecret: string;
  requestWriteItems: boolean;
}): Promise<BaseSecretActionResult> {
  try {
    const denied = await requireAdmin();
    if (denied) return denied;

    // Server Actionの引数はクライアント由来。型を信用せず自分で確かめる。
    const clientId = typeof params?.clientId === "string" ? params.clientId : "";
    const clientSecret = typeof params?.clientSecret === "string" ? params.clientSecret : "";
    const requestWriteItems = params?.requestWriteItems === true;

    let who: string | null = null;
    try {
      who = await getCurrentInventoryUserEmail();
    } catch {
      // 監査情報が取れなくても保存自体は妨げない。
    }

    await saveBaseCredentials({ clientId, clientSecret, requestWriteItems, who });
    revalidatePath("/inventory/settings");
    return {
      success: true,
      message: "アプリ認証情報を保存しました。次に「BASEアカウントを連携する」を実行してください。",
    };
  } catch (err) {
    // saveBaseCredentialsの入力検証エラーは利用者に見せる価値がある
    // （空白混入など、本人が直せる内容のため）。それ以外は畳む。
    const message = err instanceof Error ? err.message : "";
    if (message.startsWith("Client ID")) {
      return { success: false, message, retryable: false };
    }
    console.error("[saveBaseCredentialsAction] failed:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return {
      success: false,
      message: "認証情報の保存に失敗しました。時間をおいて再度お試しください。",
      retryable: true,
    };
  }
}

export async function deleteBaseCredentialsAction(): Promise<BaseSecretActionResult> {
  try {
    const denied = await requireAdmin();
    if (denied) return denied;

    // 認証情報を消すならOAuthトークンも意味を失う。片方だけ残すと
    // 「連携済みなのに使えない」という分かりにくい状態になる。
    await disconnectBase();
    await deleteBaseCredentials();
    revalidatePath("/inventory/settings");
    return { success: true, message: "アプリ認証情報とBASEアカウント連携を削除しました。" };
  } catch (err) {
    console.error("[deleteBaseCredentialsAction] failed:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return { success: false, message: "削除に失敗しました。時間をおいて再度お試しください。", retryable: true };
  }
}

export type BaseConnectionTestResult =
  | {
      success: true;
      /** 実際に取得できた商品の件数。 */
      itemCount: number;
      /** 取得できたことの証拠として画面に出す商品名（先頭数件）。 */
      sampleTitles: string[];
      message: string;
    }
  | { success: false; message: string; retryable: boolean };

/**
 * 接続テスト —— 「保存できた」ではなく「**実際にBASEの商品APIから商品を
 * 取得できた**」ことを確認する。
 *
 * BASEの `/1/items` を実際に叩くので、認証情報・OAuthトークン・スコープの
 * どれが欠けていても、その時点で正直に失敗する。作り物の商品は返さない
 * (getBaseClient()が本番でモックを選ばないことは lib/base/index.ts 参照)。
 */
export async function testBaseConnectionAction(): Promise<BaseConnectionTestResult> {
  try {
    const denied = await requireAdmin();
    if (denied) return { success: false, message: denied.message, retryable: false };

    // 空クエリ = 絞り込みなしでショップの商品一覧を読む。
    const result = await getBaseClient().search({ query: "", limit: 5 });
    const items = result.items;

    if (items.length === 0) {
      // APIは通ったが商品が0件。「繋がっていない」とは違うので分けて伝える。
      return {
        success: true,
        itemCount: 0,
        sampleTitles: [],
        message: "BASE商品APIへの接続には成功しましたが、取得できた商品が0件でした。BASEショップに公開中の商品があるかご確認ください。",
      };
    }

    return {
      success: true,
      itemCount: items.length,
      sampleTitles: items.slice(0, 5).map((item) => item.title || `(商品ID ${item.itemId})`),
      message: `BASE商品APIから実際に商品を取得できました（先頭${items.length}件）。`,
    };
  } catch (err) {
    if (err instanceof BaseNotConfiguredError) {
      return { success: false, message: err.message, retryable: false };
    }
    if (err instanceof BaseNotConnectedError) {
      return { success: false, message: err.message, retryable: false };
    }
    if (err instanceof BaseApiError) {
      // BaseApiErrorのmessageにはBASEの応答本文が入り得るので、そのままは出さない。
      console.error("[testBaseConnectionAction] BASE API error:", err.status, err.message);
      return {
        success: false,
        message:
          err.status === 401 || err.status === 403
            ? "BASEが認証を拒否しました。連携をやり直すか、BASE Developers側の利用権限（商品情報を見る）をご確認ください。"
            : `BASEからエラーが返りました（HTTP ${err.status ?? "不明"}）。時間をおいて再度お試しください。`,
        retryable: err.status === undefined || err.status >= 500,
      };
    }
    console.error("[testBaseConnectionAction] unexpected error:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return { success: false, message: "接続テスト中に予期しないエラーが発生しました。時間をおいて再度お試しください。", retryable: true };
  }
}
