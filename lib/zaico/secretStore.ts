import "server-only";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
  DeleteSecretCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-secrets-manager";

/**
 * ZAICO API TOKENの安全な保存先(夜間開発指示書 §14)。
 *
 * ── 経路 ────────────────────────────────────────────────────────────
 * ブラウザ(設定画面のTOKEN入力フォーム、password type)
 *   → Server Action (app/actions/zaicoSecret.ts、ADMIN限定)
 *     → このファイル(AWS SDK、AWS Secrets Manager)
 *
 * TOKEN本体は一切保存しない場所:
 * - Inventory / 通常DynamoDB(a.model()のいずれの列にも書かない)
 * - localStorage / sessionStorage / cookie
 * - フロントJS(Server Actionの戻り値には「成功/失敗」の真偽値と検証
 *   メッセージだけを含め、TOKEN文字列そのものは一度もクライアントへ
 *   返さない — app/actions/zaicoSecret.ts参照)
 * - Git / ソースコード / 平文の設定ファイル
 *
 * ── なぜAWS Secrets Managerか ─────────────────────────────────────
 * Amplify Gen2の`secret()`プリミティブ(ampx sandbox secret set)は
 * バックエンドのFunctionリソース(Lambdaの環境変数)向けに設計されて
 * おり、このアプリのZAICO_API_TOKEN利用箇所(lib/zaico/client.ts)は
 * Amplify Functionではなく、Amplify HostingでホストされるNext.js
 * サーバーサイドコード(Server Action/Route Handler)側にある。
 * Amplify Hosting for Next.js SSRのコンピュート実行ロールへ
 * `defineBackend()`から直接IAMポリシーを付与する一級の手段が現状無い
 * ため(amplify/backend.tsのコメント参照)、この用途では素直に
 * AWS Secrets Managerを直接使い、実行ロールへの読み書き権限だけを
 * Amplify Console側で付与してもらう方式を選んだ — ユーザー本人のAWS
 * 操作が必要な部分は完了報告のBLOCKED_BY_USERにまとめてある。
 *
 * ── フォールバック ───────────────────────────────────────────────
 * Secrets Managerが未設定・権限未許可・ネットワーク到達不可の場合は
 * 例外を投げず`null`を返す — 呼び出し側(lib/zaico/client.tsの
 * getZaicoApiToken)がこれまで通り`process.env.ZAICO_API_TOKEN`
 * (ローカル開発の.env.local、または本番のAmplify Hosting環境変数)へ
 * フォールバックするため、AWS側のIAM許可がまだ済んでいない状態でも
 * 既存の動作を一切壊さない。
 */

const SECRET_NAME = "bello/zaico-api-token";

let cachedClient: SecretsManagerClient | null = null;
function getClient(): SecretsManagerClient {
  // ハードコードされた認証情報は一切渡さない — Amplify Hosting(SSRコン
  // ピュート)の実行ロールに紐づくアンビエントな認証情報チェーンをその
  // まま使う(ローカル開発では通常この呼び出し自体が失敗し、null
  // フォールバックへ回る想定)。
  if (!cachedClient) cachedClient = new SecretsManagerClient({});
  return cachedClient;
}

/** 真偽値だけを返す用途(設定画面の「接続済み/未設定」表示)にも使えるよう、値の有無をnullで表す。トークン値そのものは呼び出し元(server-onlyのコードのみ)に返るだけで、ログには一切出さない。 */
export async function getZaicoTokenFromSecretsManager(): Promise<string | null> {
  try {
    const res = await getClient().send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
    return res.SecretString ?? null;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return null;
    // 権限不足・ネットワーク不可等は「未設定」として扱い、呼び出し側の
    // 環境変数フォールバックへ進める。詳細なAWSエラー内容もログに出さ
    // ない(何が原因か知りたい場合はCloudWatchの実行ロール/IAMエラー
    // そのものを見るのが正しい経路であり、この関数の戻り値からは判別
    // できないようにしている — spec: TOKEN値だけでなくエラー詳細も
    // 不用意に出さない)。
    console.warn("[zaico secretStore] Secrets Managerからの取得に失敗しました。環境変数(ZAICO_API_TOKEN)へフォールバックします。");
    return null;
  }
}

/**
 * 保存前にZAICO GET APIでの検証は呼び出し側(app/actions/zaicoSecret.ts)
 * の責務 — このファイルはSecrets Managerへの実際の書き込みだけを行う。
 * シークレットがまだ存在しなければ作成する(初回設定)。
 */
export async function setZaicoTokenInSecretsManager(token: string): Promise<void> {
  const client = getClient();
  try {
    await client.send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: token }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      await client.send(new CreateSecretCommand({ Name: SECRET_NAME, SecretString: token }));
      return;
    }
    console.error("[zaico secretStore] Secrets Managerへの保存に失敗しました(理由はAWS側のログを参照)。");
    throw new Error(
      "Secrets Managerへの保存に失敗しました。AWS側のIAM権限（このアプリの実行ロールにsecretsmanager:PutSecretValue / CreateSecretの許可）が設定されているか確認してください。",
    );
  }
}

export async function deleteZaicoTokenFromSecretsManager(): Promise<void> {
  try {
    await getClient().send(new DeleteSecretCommand({ SecretId: SECRET_NAME, ForceDeleteWithoutRecovery: true }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return;
    console.error("[zaico secretStore] Secrets Managerの削除に失敗しました(理由はAWS側のログを参照)。");
    throw new Error("Secrets Managerからの削除に失敗しました。AWS側のIAM権限（secretsmanager:DeleteSecret）を確認してください。");
  }
}
