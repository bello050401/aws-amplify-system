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
 * Mercari Shops Personal API Access Tokenの安全な保存先(BELLO統合改修
 * master指示書 Phase D)。lib/zaico/secretStore.tsと同一のアーキテクチャ
 * ・安全性の考え方(構造化JSON `{configured, token?}`、TOKEN本体を
 * NEVER log、PutSecretValue優先+ResourceNotFoundExceptionの時だけ
 * CreateSecretへフォールバック、削除は物理削除ではなく
 * UNCONFIGURED_SECRET_PAYLOADへの書き戻し)を、Mercari用に複製した別
 * ファイル — 既にAWS上で動作確認済みのZAICO側の実装(および、そこへ
 * 至った複数のインシデント調査で積み上げたコメント)には一切手を加えず、
 * 新しいSecret用に同じ安全なパターンをもう一つ用意するほうが、共通化
 * のために既存の動作確認済みコードを触るより安全という判断による、
 * 意図的な重複(app/inventory/(protected)/[id]/edit/EditInventoryForm.tsx
 * のformatDateTime重複と同じ理由)。
 *
 * amplify/backend.tsで、この名前のSecretはCDKが新規作成する
 * (`new Secret(...)`) — ZAICOのSecretとは異なり、Mercari用のSecretは
 * このアプリがAWSアカウント上に存在させる初めての実体であり、
 * 「既存の外部リソースをimportする」必要はない(ZAICOのSecretが
 * `Secret.fromSecretNameV2()`でimportされているのは、production環境で
 * 既にCDK管理外の実体として存在していたため — amplify/backend.tsの
 * コメント参照)。
 *
 * 実行ロールへの読み書き権限をdefineBackend()から直接付与できない制約
 * もZAICOと全く同じ(Amplify Hosting Next.js SSRコンピュートの実行ロール
 * は`defineBackend()`のリソース一覧に含まれない) — こちらもAmplify
 * Console側でのADMINによる手動IAMポリシー追加が必要(完了報告の
 * BLOCKED_BY_USER参照)。それまではgetMercariAccessTokenが環境変数
 * MERCARI_ACCESS_TOKENへフォールバックする。
 */

const SECRET_NAME = "bello/mercari-access-token";

const SECRET_DESCRIPTION =
  "BELLO在庫管理システム — Mercari Shops Personal API Access Token(EC出品機能専用)。設定画面(ADMIN限定)から読み書きする。";

/** lib/zaico/secretStore.tsと同じ理由(BELLOの実デプロイ先リージョン)でus-west-2をフォールバックにする。 */
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2";

interface MercariTokenSecretPayload {
  configured: boolean;
  token?: string;
  /**
   * 夜間統合指示書(2026-09-01) §3.4: 「接続済み」と「設定済みだが未検証」を
   * 混同しないための状態。
   *
   * 以前はSecretへの書き込みが「接続確認に成功した場合のみ」行われていた。
   * ところがMercariは**未登録の送信元IPからのリクエストへ、認証を評価する
   * 前に404を返す**(公式FAQ「申請いただいていないIPアドレスからの
   * リクエストに対しては404 NotFoundが返却されます」/ 2026-09-01の実測でも
   * Authorizationヘッダを一切付けない場合と付けた場合で応答が完全に同一)。
   * つまりIPが未登録の間は、**正しいTOKENを入力しても接続確認は絶対に
   * 成功せず、したがってTOKENを保存することもできない**——実際にこの
   * Secretは作成時の`{configured:false}`のまま一度も更新されていなかった。
   * これが「保存デッドロック」の実体である。
   *
   * そこで「検証は取れていないが、利用者が入力した設定を保持している」
   * 状態を表現できるようにした。verified=falseの設定は接続済みとは
   * 表示せず、EC出品機能も従来どおりTOKENが揃っていなければ動かないが、
   * 少なくとも入力内容が消えず、IP登録が完了した時点で「接続確認」を
   * 押すだけで済むようになる。
   *
   * 後方互換: このフィールドが存在しない既存payloadは、当時の保存経路が
   * 検証成功時にしか書き込まなかったことから「検証済み」とみなす
   * (verified !== false)。
   */
  verified?: boolean;
  /** 最後に接続確認を試みた時刻(ISO8601)。秘密値ではない。 */
  lastCheckedAt?: string;
  /** 最後の接続確認の結果コード(MercariErrorCode、成功時は"OK")。秘密値ではない。 */
  lastCheckCode?: string;
  /**
   * BELLO統合業務OS指示書(2026-08-30) §24/§26: MercariのUser-Agent
   * ヘッダに必要なAPIクライアント名/バージョン。TOKENと違い秘匿情報
   * そのものではないが、§26「Client Nameもserver-side
   * config。environment variable fallback可」— TOKENと全く同じ
   * 「Secrets Manager優先・環境変数フォールバック」の経路に乗せる
   * (設定画面から2つまとめて1回のvalidate+saveで保存できるようにする
   * ため、TOKENと同じsecretのpayloadへ同居させている — 新しいSecretを
   * もう一つ作る理由が無い)。
   */
  clientName?: string;
  clientVersion?: string;
}

/** IaCの初期値・削除後の値として書き込む「未設定」ペイロード。amplify/backend.tsのSecret初期値と完全に同じ形にすること。 */
export const UNCONFIGURED_MERCARI_SECRET_PAYLOAD: MercariTokenSecretPayload = { configured: false };

let cachedClient: SecretsManagerClient | null = null;
function getClient(): SecretsManagerClient {
  if (!cachedClient) cachedClient = new SecretsManagerClient({ region: REGION });
  return cachedClient;
}

function parsePayload(raw: string | undefined): MercariTokenSecretPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "configured" in parsed) return parsed as MercariTokenSecretPayload;
    return null;
  } catch {
    return null;
  }
}

/** lib/zaico/secretStore.tsのlogAwsErrorと同じ方針 — TOKEN本体は絶対に出さず、診断情報のみ。 */
function logAwsError(operation: string, err: unknown): void {
  const anyErr = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } } | null;
  console.error(
    `[mercari secretStore] ${operation} 失敗: ` +
      `name=${anyErr?.name ?? "(unknown)"} ` +
      `message=${anyErr?.message ?? String(err)} ` +
      `httpStatusCode=${anyErr?.$metadata?.httpStatusCode ?? "-"} ` +
      `requestId=${anyErr?.$metadata?.requestId ?? "-"} ` +
      `region=${REGION}`,
  );
}

/** lib/zaico/secretStore.tsのclassifyAwsErrorと同じ分類方針。 */
function classifyAwsError(err: unknown): string {
  if (err instanceof ResourceNotFoundException) return "AWS Secrets ManagerにMercari用のSecretがまだ存在しません。";
  const name = err instanceof Error ? err.name : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (name === "AccessDeniedException") {
    return "AWS Secrets Managerへのアクセス権限がありません。このアプリの実行ロールへ、対象Secret(bello/mercari-access-token)に対するsecretsmanager:GetSecretValue・PutSecretValueの権限を確認してください。";
  }
  if (name === "CredentialsProviderError" || /could not load credentials/i.test(message)) {
    return "AWS認証情報を確認できません。ローカル環境ではAWS CLIのプロファイル設定またはSSOログイン、AWS上で実行している場合は実行ロールの設定を確認してください。";
  }
  if (name === "UnrecognizedClientException" || name === "InvalidSignatureException" || name === "InvalidClientTokenId" || name === "ExpiredTokenException") {
    return "AWS認証情報が無効です(期限切れの可能性があります)。";
  }
  if (/region is missing/i.test(message)) return "AWSリージョンが設定されていません。環境変数 AWS_REGION を設定してください。";
  if (name === "TimeoutError" || /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(message)) {
    return "AWS Secrets Managerへの接続に失敗しました(ネットワーク到達不可)。";
  }
  return `Secrets Managerへの保存に失敗しました(${name ?? "unknown error"})。詳細はサーバーログを確認してください。`;
}

/**
 * token/clientName/clientVersionをまとめて1回のGetSecretValueで返す —
 * 3つとも同じsecretの同じpayloadに同居しているため、個別に3回
 * GetSecretValueを呼ぶ理由が無い(§126のrate limit意識にも合う)。
 * 未設定(configured=false)の場合は3つとも null。
 */
/**
 * Secret読み取りの結果。夜間統合指示書(2026-09-01) §6.1の
 * 「error swallowing / silent failure」監査で見つかった問題への対応:
 * 以前はGetSecretValueが**どんな理由で失敗しても**catchで握り潰して
 * `{token:null,...}`を返していた。呼び出し側から見ると、これは
 * 「まだ設定されていない」と全く区別が付かない。
 *
 * 実害: IAM権限が外れている/AWS認証情報が切れている状態でも、設定画面は
 * 淡々と「未設定」と表示する。利用者は正しく保存済みのTOKENを
 * 「消えた」と受け取り、再入力を繰り返すことになる(そして再入力もまた
 * 別の理由で失敗する)。原因が画面のどこにも出ない。
 *
 * そこで「未設定(ok:true, token:null)」と「読めなかった(ok:false)」を
 * 型として分離する。
 */
export type MercariSecretRead =
  | {
      ok: true;
      token: string | null;
      clientName: string | null;
      clientVersion: string | null;
      /** configured=true かつ接続確認済みか(上のpayloadコメントの後方互換規則を適用済み)。 */
      verified: boolean;
      lastCheckedAt: string | null;
      lastCheckCode: string | null;
    }
  | { ok: false; errorMessage: string };

const EMPTY_READ = { ok: true, token: null, clientName: null, clientVersion: null, verified: false, lastCheckedAt: null, lastCheckCode: null } as const;

/** 読み取り失敗を「未設定」と区別して返す、このファイルの正となる読み取り関数。 */
export async function readMercariConnectionSecret(): Promise<MercariSecretRead> {
  let res;
  try {
    res = await getClient().send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
  } catch (err) {
    // Secretがまだ存在しないのは「読み取り失敗」ではなく「未設定」——
    // IaCで作られる前の状態であり、利用者が対処すべき異常ではない。
    if (err instanceof ResourceNotFoundException) return { ...EMPTY_READ };
    logAwsError("getSecretValue", err);
    return { ok: false, errorMessage: classifyAwsError(err) };
  }
  const payload = parsePayload(res.SecretString);
  if (!payload?.configured) return { ...EMPTY_READ };
  return {
    ok: true,
    token: payload.token?.trim() || null,
    clientName: payload.clientName?.trim() || null,
    clientVersion: payload.clientVersion?.trim() || null,
    verified: payload.verified !== false,
    lastCheckedAt: payload.lastCheckedAt?.trim() || null,
    lastCheckCode: payload.lastCheckCode?.trim() || null,
  };
}

/**
 * 既存の呼び出し元(lib/listing/mercari/tokenAccess.ts)が使う従来の形。
 * 読み取り失敗時は従来どおり「値なし」に見えるが、それは
 * **実際にTOKENを使えない**という一点においては正しい振る舞いである
 * (握り潰しが問題なのは「画面表示上、未設定と失敗を区別できない」点なので、
 * 状態表示のほうはreadMercariConnectionSecretを直接使う)。
 */
export async function getMercariConnectionFromSecretsManager(): Promise<{ token: string | null; clientName: string | null; clientVersion: string | null }> {
  const read = await readMercariConnectionSecret();
  if (!read.ok) return { token: null, clientName: null, clientVersion: null };
  return { token: read.token, clientName: read.clientName, clientVersion: read.clientVersion };
}

/** lib/listing/mercari/tokenAccess.tsからのみ呼ばれる薄いラッパー — 呼び出し側の意図(「TOKENだけ知りたい」)を名前で表す。 */
export async function getMercariTokenFromSecretsManager(): Promise<string | null> {
  return (await getMercariConnectionFromSecretsManager()).token;
}

/**
 * BELLO統合業務OS指示書(2026-08-30) §24: 設定画面の「接続確認して
 * 保存」ボタン1つで、APIクライアント名とTOKENをまとめて保存する
 * (§92: 保存前に必ず接続検証し、成功したものだけ確定する — この関数
 * 自体は検証済みの値を保存するだけで、検証は呼び出し元
 * app/actions/mercariSecret.tsのServer Action側が
 * lib/listing/mercari/adapter.tsのvalidateMercariConnectionで先に行う)。
 */
export async function setMercariConnectionInSecretsManager(params: {
  token: string;
  clientName: string;
  clientVersion?: string;
  /** 接続確認が取れているか。省略時はtrue(従来どおり「検証成功後にだけ保存する」経路の互換)。 */
  verified?: boolean;
  /** 最後に接続確認を試みた結果コード(成功なら"OK")。 */
  lastCheckCode?: string;
}): Promise<void> {
  const payload: MercariTokenSecretPayload = {
    configured: true,
    token: params.token,
    clientName: params.clientName,
    clientVersion: params.clientVersion,
    verified: params.verified !== false,
    lastCheckedAt: new Date().toISOString(),
    lastCheckCode: params.lastCheckCode,
  };
  const secretString = JSON.stringify(payload);

  try {
    await getClient().send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: secretString }));
    return;
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) {
      logAwsError("putSecretValue", err);
      throw new Error(classifyAwsError(err));
    }
  }

  try {
    await getClient().send(new CreateSecretCommand({ Name: SECRET_NAME, Description: SECRET_DESCRIPTION, SecretString: secretString }));
    return;
  } catch (err) {
    if (err instanceof ResourceExistsException) {
      try {
        await getClient().send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: secretString }));
        return;
      } catch (retryErr) {
        logAwsError("putSecretValue(after race with concurrent create)", retryErr);
        throw new Error(classifyAwsError(retryErr));
      }
    }
    logAwsError("createSecret", err);
    throw new Error(classifyAwsError(err));
  }
}

export async function clearMercariTokenInSecretsManager(): Promise<void> {
  try {
    await getClient().send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: JSON.stringify(UNCONFIGURED_MERCARI_SECRET_PAYLOAD) }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return;
    logAwsError("putSecretValue(clear)", err);
    throw new Error(classifyAwsError(err));
  }
}
