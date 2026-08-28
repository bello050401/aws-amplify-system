import "server-only";
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand, ResourceNotFoundException } from "@aws-sdk/client-secrets-manager";

/**
 * ZAICO API TOKENの安全な保存先(夜間開発指示書 §14。ユーザーからの
 * 安全性レビュー指摘を受け設計変更 — 「デプロイ前の安全性レビュー」参照)。
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
 * ── IaCとアプリの責務分離(重要、安全性レビューでの指摘を反映) ──────
 * Secretリソースそのもの(CloudFormationスタックが管理する実体)の
 * 作成・削除はamplify/backend.ts(CDK)だけが行う。このファイルは
 * 既にIaCが作成済みのSecretの「値(バージョン)」をGetSecretValue /
 * PutSecretValueで読み書きするだけで、CreateSecret / DeleteSecretは
 * 一切呼ばない — CloudFormationが所有するリソースをアプリが物理的に
 * 作成・削除すると、次回のcdk diff/deployでdrift(定義と実体の不一致)
 * や削除の競合が起こり得るため。したがってSSR実行ロールに付与すべき
 * IAM権限も secretsmanager:GetSecretValue と PutSecretValue の2つだけ
 * でよい(CreateSecret/DeleteSecretは不要 — 完了報告のIAMポリシー例
 * 参照)。
 *
 * ── 「未設定」の表現方法 ─────────────────────────────────────────
 * Secrets Managerの値そのものを空文字列にする設計は避けた(一部API/
 * バリデーションで空値が弾かれる可能性があるうえ、「値はあるが空」と
 * 「そもそも設定されていない」が区別しづらい)。代わりに構造化JSONの
 * `{ configured: boolean, token?: string }` を値として保持し、
 * `configured: false`(tokenフィールドなし)を「未設定」の正式な状態
 * として扱う — アプリからの「削除」操作は、Secretの値をこの
 * unconfigured払いのJSONへ書き戻すだけ(PutSecretValueのみ)で、
 * Secretリソース自体には一切触れない。IaC側(amplify/backend.ts)が
 * 初期値としてこの同じunconfigured JSONを設定してSecretを作成する
 * ため、アプリ側がCreateSecretを呼ぶ必要も無くなる。
 *
 * ── フォールバック ───────────────────────────────────────────────
 * Secrets Managerが未設定・権限未許可・ネットワーク到達不可・値が
 * 壊れている(JSONとして読めない)場合は例外を投げず`null`を返す —
 * 呼び出し側(lib/zaico/client.tsのgetZaicoApiToken)がこれまで通り
 * `process.env.ZAICO_API_TOKEN`(ローカル開発の.env.local、または
 * 本番のAmplify Hosting環境変数)へフォールバックするため、AWS側の
 * IAM許可・デプロイがまだ済んでいない状態でも既存の動作を一切壊さない。
 */

const SECRET_NAME = "bello/zaico-api-token";

/** amplify/backend.tsのSecret初期値と同じ形。ここだけの正規表現ではなく型で共有したいところだが、CDK側はJSON文字列としてしか渡せないため、キー名の一致をコメントで明示するに留める。 */
interface ZaicoTokenSecretPayload {
  configured: boolean;
  token?: string;
}

/** IaCが設定した初期値・削除後の値として書き込む「未設定」ペイロード。amplify/backend.tsのSecret初期値と完全に同じ形にすること。 */
export const UNCONFIGURED_SECRET_PAYLOAD: ZaicoTokenSecretPayload = { configured: false };

let cachedClient: SecretsManagerClient | null = null;
function getClient(): SecretsManagerClient {
  // ハードコードされた認証情報は一切渡さない — Amplify Hosting(SSRコン
  // ピュート)の実行ロールに紐づくアンビエントな認証情報チェーンをその
  // まま使う(ローカル開発では通常この呼び出し自体が失敗し、null
  // フォールバックへ回る想定)。
  if (!cachedClient) cachedClient = new SecretsManagerClient({});
  return cachedClient;
}

/** JSONとして読めない・形が想定と違う値は「未設定」として扱う(例外を投げない) — 過去のプレーン文字列値や手動編集で壊れた値が来ても安全側に倒す。 */
function parsePayload(raw: string | undefined): ZaicoTokenSecretPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "configured" in parsed) return parsed as ZaicoTokenSecretPayload;
    return null;
  } catch {
    return null;
  }
}

/** 真偽値だけを返す用途(設定画面の「接続済み/未設定」表示)にも使えるよう、値の有無をnullで表す。トークン値そのものは呼び出し元(server-onlyのコードのみ)に返るだけで、ログには一切出さない。 */
export async function getZaicoTokenFromSecretsManager(): Promise<string | null> {
  try {
    const res = await getClient().send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
    const payload = parsePayload(res.SecretString);
    if (!payload?.configured) return null;
    return payload.token?.trim() || null;
  } catch {
    // 権限不足・ネットワーク不可・Secretが未デプロイ等は「未設定」とし
    // て扱い、呼び出し側の環境変数フォールバックへ進める。詳細なAWS
    // エラー内容もログに出さない(何が原因か知りたい場合はCloudWatchの
    // 実行ロール/IAMエラーそのものを見るのが正しい経路であり、この関数
    // の戻り値からは判別できないようにしている — spec: TOKEN値だけで
    // なくエラー詳細も不用意に出さない)。
    console.warn("[zaico secretStore] Secrets Managerからの取得に失敗しました。環境変数(ZAICO_API_TOKEN)へフォールバックします。");
    return null;
  }
}

/**
 * 保存前にZAICO GET APIでの検証は呼び出し側(app/actions/zaicoSecret.ts)
 * の責務 — このファイルはSecrets Managerへの実際の書き込み
 * (PutSecretValueのみ、CreateSecretは呼ばない — ファイル冒頭コメント
 * 参照)だけを行う。Secretリソース自体はamplify/backend.ts(IaC)が
 * 事前に作成済みである前提 — もしまだデプロイされていなければ
 * ResourceNotFoundExceptionとなり、そのまま分かりやすいエラーを投げる
 * (この関数はエラーを握りつぶさない — 保存の成否をADMINへ正確に伝える
 * 必要があるため)。
 */
export async function setZaicoTokenInSecretsManager(token: string): Promise<void> {
  const payload: ZaicoTokenSecretPayload = { configured: true, token };
  try {
    await getClient().send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: JSON.stringify(payload) }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      throw new Error(
        "AWS Secrets ManagerにZAICO用のSecretがまだ存在しません。AWS側のデプロイ(ampx sandbox / pipeline-deploy)が完了しているか確認してください。",
      );
    }
    console.error("[zaico secretStore] Secrets Managerへの保存に失敗しました(理由はAWS側のログを参照)。");
    throw new Error(
      "Secrets Managerへの保存に失敗しました。AWS側のIAM権限（このアプリの実行ロールにsecretsmanager:PutSecretValueの許可）が設定されているか確認してください。",
    );
  }
}

/**
 * 「削除」操作の実体 — spec変更: Secretリソース自体は物理削除しない
 * (DeleteSecretは呼ばない)。値を`UNCONFIGURED_SECRET_PAYLOAD`
 * ({configured:false})へ書き戻すだけ(PutSecretValue)にすることで、
 * CloudFormationが所有するリソースのライフサイクルには一切触れず、
 * ADMIN操作としては「未設定状態に戻る」という同じ結果を安全に実現する。
 */
export async function clearZaicoTokenInSecretsManager(): Promise<void> {
  try {
    await getClient().send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: JSON.stringify(UNCONFIGURED_SECRET_PAYLOAD) }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return; // まだデプロイされていない = 元々未設定と同じ状態なので成功扱い
    console.error("[zaico secretStore] Secrets Managerの更新に失敗しました(理由はAWS側のログを参照)。");
    throw new Error(
      "Secrets Managerの更新に失敗しました。AWS側のIAM権限（このアプリの実行ロールにsecretsmanager:PutSecretValueの許可）が設定されているか確認してください。",
    );
  }
}
