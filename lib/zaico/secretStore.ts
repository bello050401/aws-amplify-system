import "server-only";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
  ResourceNotFoundException,
  ResourceExistsException,
} from "@aws-sdk/client-secrets-manager";

/**
 * ZAICO API TOKENの安全な保存先(夜間開発指示書 §14。安全性レビュー指摘
 * を受け設計変更 — 「デプロイ前の安全性レビュー」参照。さらに追加修正
 * (「Secrets Managerへの保存に失敗しました」エラーの根本原因調査)で、
 * エラー分類・upsert対応・診断ログを追加)。
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
 * - サーバーログ(このファイルのlogAwsErrorは、AWSエラーの診断情報
 *   (name/message/httpStatusCode/requestId)のみを出力し、SecretString
 *   (TOKEN本体を含むJSON)は絶対にログへ渡さない)
 *
 * ── 実行主体(ローカル npm run dev / AWS Amplify Hosting) ───────────
 * この関数群は"use server"のServer Actionから呼ばれるサーバーサイド
 * コードで、Lambda/Amplify Functionではない。したがって:
 *   - `npm run dev`でのローカル動作確認中は、開発者のローカルNode.js
 *     プロセスとしてこのコードが実行される。AWS SDKは通常の資格情報
 *     プロバイダーチェーン(環境変数 → 共有設定ファイル ~/.aws/credentials
 *     /~/.aws/config → SSOキャッシュ → EC2/ECSメタデータ、の順)から
 *     資格情報を探す。ローカル端末にAWS CLIプロファイル/SSOログインが
 *     無ければここで失敗する — Lambda実行ロールとは無関係。
 *   - Amplify Hostingへデプロイ後は、同じコードがAmplify Hostingの
 *     SSRコンピュート実行ロールの資格情報で動く(amplify/backend.tsの
 *     コメント参照 — この実行ロールへは`defineBackend()`から直接IAM
 *     ポリシーを付与できないため、Amplify Console側の手動設定が必要)。
 * どちらの場合も、リージョン・資格情報が正しく解決できているかは
 * classifyAwsError/logAwsErrorで診断できるようにしている。
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
 * 操作が必要な部分は完了報告にまとめてある。
 *
 * ── IaCとアプリの責務分離(今回の追加修正で一部改訂) ────────────────
 * Secretリソースそのもの(CloudFormationスタックが管理する実体)は、
 * 通常運用ではamplify/backend.ts(CDK)が事前に作成する。しかし、CDK
 * デプロイ未実施の環境(ローカルsandbox初回セットアップ時等)でADMINが
 * 先に設定画面からTOKENを保存しようとした場合に保存できない問題への
 * 対応として、ユーザー指示によりsetZaicoTokenInSecretsManagerへ
 * upsert(PutSecretValueが「Secretが存在しない」ことを示す
 * ResourceNotFoundExceptionを返した場合のみ、CreateSecretへ安全に
 * フォールバックする)処理を追加した。
 *   - ResourceNotFoundException**だけ**を「Secret不存在」と判断する。
 *     AccessDeniedException等、他の例外は絶対にこの分岐に落とさない
 *     (classifyAwsError参照)。
 *   - DeleteSecretは今回も一切呼ばない(「削除」操作は引き続き
 *     UNCONFIGURED_SECRET_PAYLOADへのPutSecretValueのみ)。
 *   - 通常運用でCDKが既にSecretを作成済みであれば、この
 *     CreateSecretフォールバックが実際に呼ばれることはない
 *     (PutSecretValueがそのまま成功するため)。
 *   - 既知のトレードオフ: もしアプリがCreateSecretで先にこのSecretを
 *     作成した状態で、後からamplify/backend.tsのCDKスタックを初めて
 *     デプロイすると、CloudFormationは同名のSecretが既にCloudFormation
 *     管理外に存在するためスタック作成に失敗し得る(「すでに存在します」
 *     エラー)。その場合は`cdk import`でこのSecretをCloudFormation管理
 *     下へ取り込むか、AWSコンソールから対象Secretを削除してから
 *     CDKデプロイをやり直す必要がある。実運用では「CDKを先にデプロイ
 *     する」運用を推奨するが、アプリ側の可用性(ADMINがいつTOKENを設定
 *     しても保存できること)を優先し、このフォールバックを実装した。
 *
 * ── 「未設定」の表現方法 ─────────────────────────────────────────
 * Secrets Managerの値そのものを空文字列にする設計は避けた(一部API/
 * バリデーションで空値が弾かれる可能性があるうえ、「値はあるが空」と
 * 「そもそも設定されていない」が区別しづらい)。代わりに構造化JSONの
 * `{ configured: boolean, token?: string }` を値として保持し、
 * `configured: false`(tokenフィールドなし)を「未設定」の正式な状態
 * として扱う。
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

const SECRET_DESCRIPTION =
  "BELLO在庫管理システム — ZAICO API TOKEN(ZAICO→BELLO一方向同期専用、GETのみ)。設定画面(ADMIN限定)から読み書きする。";

/**
 * BELLOのAmplify環境はus-east-1(ユーザー指定)。AWS SDKはリージョンを
 * 環境変数(AWS_REGION/AWS_DEFAULT_REGION)や~/.aws/configの既定プロ
 * ファイルから解決しようとするが、ローカル開発端末でこれが一つも設定
 * されていない場合、SecretsManagerClientはネットワークへ一度も出ずに
 * 同期的に`Error: Region is missing`を投げる(AWSの実エラーではなく
 * SDK内のコンフィグエラー)。このエラーは`instanceof ResourceNotFoundException`
 * ではないため、これまでのコードでは「IAM権限不足」という誤った
 * メッセージに丸められてしまっていた(今回の調査で実際に再現・特定した
 * 根本原因の一つ)。環境変数が明示されていればそれを優先しつつ、未設定
 * の場合はBELLOの既知のリージョンへ明示的にフォールバックすることで、
 * この種の設定エラー自体を未然に防ぐ。
 */
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

/** amplify/backend.tsのSecret初期値と同じ形。ここだけの正規表現ではなく型で共有したいところだが、CDK側はJSON文字列としてしか渡せないため、キー名の一致をコメントで明示するに留める。 */
interface ZaicoTokenSecretPayload {
  configured: boolean;
  token?: string;
}

/** IaCが設定した初期値・削除後の値として書き込む「未設定」ペイロード。amplify/backend.tsのSecret初期値と完全に同じ形にすること。 */
export const UNCONFIGURED_SECRET_PAYLOAD: ZaicoTokenSecretPayload = { configured: false };

let cachedClient: SecretsManagerClient | null = null;
function getClient(): SecretsManagerClient {
  // ハードコードされた認証情報は一切渡さない — ローカルではAWS CLI/SSOの
  // アンビエントな資格情報チェーン、AWS上ではAmplify Hosting(SSRコン
  // ピュート)の実行ロールに紐づく資格情報チェーンを、どちらもSDKの既定
  // プロバイダーチェーンにそのまま解決させる。リージョンだけは上記の
  // 理由により明示的に指定する。
  if (!cachedClient) cachedClient = new SecretsManagerClient({ region: REGION });
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

/**
 * AWS SDKエラーの診断情報をサーバーログへ出す(開発時の原因追跡用)。
 * name/message/HTTPステータス/AWSリクエストIDだけを出し、SecretString
 * (TOKEN本体を含むJSON)やpayload引数は絶対に渡さない・出力しない。
 * CloudWatch Logsでも同じ形で見えるため、本番でのトラブルシュートにも
 * そのまま使える(TOKENを含まない情報のみなので出力して問題ない)。
 */
function logAwsError(operation: string, err: unknown): void {
  const anyErr = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } } | null;
  console.error(
    `[zaico secretStore] ${operation} 失敗: ` +
      `name=${anyErr?.name ?? "(unknown)"} ` +
      `message=${anyErr?.message ?? String(err)} ` +
      `httpStatusCode=${anyErr?.$metadata?.httpStatusCode ?? "-"} ` +
      `requestId=${anyErr?.$metadata?.requestId ?? "-"} ` +
      `region=${REGION}`,
  );
}

type AwsErrorKind = "not-found" | "access-denied" | "no-credentials" | "invalid-credentials" | "region-missing" | "network" | "unknown";

/**
 * 実際のAWS SDKエラーを原因ごとに分類し、ユーザー(ADMIN)向けの日本語
 * メッセージへ変換する。「PutSecretValueの許可を確認してください」で
 * 一律に丸めていた従来の実装を、実際のerror.name/messageに基づく判定
 * へ置き換えたもの(今回の調査対応の中心)。ZAICO API自体の接続失敗
 * (認証エラー等)はapp/actions/zaicoSecret.tsのvalidateZaicoToken側で
 * 別途・先に判定されるため、ここで扱うのはAWS Secrets Manager呼び出し
 * が失敗した場合のみ — ZAICOの認証エラーとAWSの保存エラーを混同しない。
 */
function classifyAwsError(err: unknown): { kind: AwsErrorKind; userMessage: string } {
  if (err instanceof ResourceNotFoundException) {
    return { kind: "not-found", userMessage: "AWS Secrets ManagerにZAICO用のSecretがまだ存在しません。" };
  }

  const name = err instanceof Error ? err.name : undefined;
  const message = err instanceof Error ? err.message : String(err);

  if (name === "AccessDeniedException") {
    return {
      kind: "access-denied",
      userMessage:
        "AWS Secrets Managerへのアクセス権限がありません。このアプリの実行ロール/ユーザーへ、対象Secret(bello/zaico-api-token)に対するsecretsmanager:GetSecretValue・PutSecretValue・CreateSecretの権限を確認してください。",
    };
  }
  // AWS SDKの資格情報プロバイダーチェーンが、環境変数・共有設定ファイル
  // ・SSOキャッシュ・インスタンスメタデータのいずれからも資格情報を
  // 見つけられなかった場合(ネットワーク到達前のクライアント側エラー)。
  if (name === "CredentialsProviderError" || /could not load credentials/i.test(message)) {
    return {
      kind: "no-credentials",
      userMessage:
        "AWS認証情報を確認できません。ローカル環境ではAWS CLIのプロファイル設定(aws configure)またはSSOログイン(aws sso login)、AWS上で実行している場合は実行ロールの設定を確認してください。",
    };
  }
  // 資格情報自体は見つかったが、AWS側がその署名/トークンを拒否した
  // 場合(期限切れのSSOトークン・誤ったキー等)。実際にAWSへリクエストが
  // 届いた結果のエラーで、IAM権限不足(AccessDenied)とは別の問題。
  if (name === "UnrecognizedClientException" || name === "InvalidSignatureException" || name === "InvalidClientTokenId" || name === "ExpiredTokenException") {
    return {
      kind: "invalid-credentials",
      userMessage: "AWS認証情報が無効です(期限切れの可能性があります)。ローカル環境ではAWS SSOの再ログイン(aws sso login)を試してください。",
    };
  }
  // AWS_REGION/AWS_DEFAULT_REGIONも~/.aws/configの既定リージョンも
  // 見つからない場合にSDKが同期的に投げるコンフィグエラー(ネットワーク
  // 到達すら発生していない)。本来はREGION定数のフォールバックで通常
  // 発生しなくなっているはずだが、念のため分類しておく。
  if (/region is missing/i.test(message)) {
    return {
      kind: "region-missing",
      userMessage: "AWSリージョンが設定されていません。環境変数 AWS_REGION を設定してください(BELLOのAmplify環境は us-east-1 です)。",
    };
  }
  if (name === "TimeoutError" || /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(message)) {
    return { kind: "network", userMessage: "AWS Secrets Managerへの接続に失敗しました(ネットワーク到達不可)。ネットワーク環境を確認してください。" };
  }

  return {
    kind: "unknown",
    userMessage: `Secrets Managerへの保存に失敗しました(${name ?? "unknown error"})。詳細はサーバーログを確認してください。`,
  };
}

/** 真偽値だけを返す用途(設定画面の「接続済み/未設定」表示)にも使えるよう、値の有無をnullで表す。トークン値そのものは呼び出し元(server-onlyのコードのみ)に返るだけで、ログには一切出さない。 */
export async function getZaicoTokenFromSecretsManager(): Promise<string | null> {
  try {
    const res = await getClient().send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
    const payload = parsePayload(res.SecretString);
    if (!payload?.configured) return null;
    return payload.token?.trim() || null;
  } catch (err) {
    // 権限不足・ネットワーク不可・Secretが未デプロイ等は「未設定」とし
    // て扱い、呼び出し側の環境変数フォールバックへ進める。TOKEN値・
    // SecretStringはログへ一切出さないが、原因追跡のためAWSエラーの
    // 診断情報(name/message/httpStatusCode/requestId)はログへ残す
    // (今回の調査対応 — 従来は理由を一切ログに残していなかった)。
    logAwsError("getSecretValue", err);
    return null;
  }
}

/**
 * 保存前にZAICO GET APIでの検証は呼び出し側(app/actions/zaicoSecret.ts)
 * の責務 — このファイルはSecrets Managerへの実際の書き込みだけを行う。
 *
 * upsert対応: 通常はPutSecretValueで既存Secretを更新する。
 * ResourceNotFoundException(Secretがまだ存在しない)を受け取った場合
 * のみ、CreateSecretで新規作成する — 他のエラー(AccessDenied等)は
 * 「不存在」とは判断せず、そのままclassifyAwsErrorで分類してエラーに
 * する。CreateSecretが同時実行のレースでResourceExistsException(直前
 * に別リクエストが作成した)を返した場合は、通常のPutSecretValueとして
 * 一度だけ再試行する。
 */
export async function setZaicoTokenInSecretsManager(token: string): Promise<void> {
  const payload: ZaicoTokenSecretPayload = { configured: true, token };
  const secretString = JSON.stringify(payload);

  try {
    await getClient().send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: secretString }));
    return;
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) {
      logAwsError("putSecretValue", err);
      throw new Error(classifyAwsError(err).userMessage);
    }
    // ResourceNotFoundExceptionだけがこの分岐に来る — Secretがまだ存在
    // しない(CDK未デプロイ等)ので、新規作成へフォールバックする。
  }

  try {
    await getClient().send(new CreateSecretCommand({ Name: SECRET_NAME, Description: SECRET_DESCRIPTION, SecretString: secretString }));
    return;
  } catch (err) {
    if (err instanceof ResourceExistsException) {
      // 直前にPutSecretValueがResourceNotFoundExceptionを返した直後、
      // 別のリクエストが先にCreateSecretしていた(まれなレース) —
      // 通常の更新として一度だけ再試行する。
      try {
        await getClient().send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: secretString }));
        return;
      } catch (retryErr) {
        logAwsError("putSecretValue(after race with concurrent create)", retryErr);
        throw new Error(classifyAwsError(retryErr).userMessage);
      }
    }
    logAwsError("createSecret", err);
    throw new Error(classifyAwsError(err).userMessage);
  }
}

/**
 * 「削除」操作の実体 — Secretリソース自体は物理削除しない(DeleteSecret
 * は呼ばない)。値を`UNCONFIGURED_SECRET_PAYLOAD`({configured:false})
 * へ書き戻すだけ(PutSecretValue)にすることで、CloudFormationが所有
 * するリソースのライフサイクルには一切触れず、ADMIN操作としては
 * 「未設定状態に戻る」という同じ結果を安全に実現する。
 *
 * Secretがまだ存在しない場合は、そもそも「未設定」状態そのものなので
 * 成功として扱う(CreateSecretへはフォールバックしない — 「削除」操作
 * でわざわざ新しいSecretを作る必要はない)。
 */
export async function clearZaicoTokenInSecretsManager(): Promise<void> {
  try {
    await getClient().send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: JSON.stringify(UNCONFIGURED_SECRET_PAYLOAD) }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return; // まだデプロイされていない = 元々未設定と同じ状態なので成功扱い
    logAwsError("putSecretValue(clear)", err);
    throw new Error(classifyAwsError(err).userMessage);
  }
}
