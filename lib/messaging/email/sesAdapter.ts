import "server-only";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { buildThreadingHeaders } from "./mime";

/**
 * BELLO統合業務OS指示書(2026-08-30) §51/§53: Emailチャネルの送信実装。
 *
 * 【既存プロバイダの有無を確認済み】このリポジトリにはメール送信の
 * 既存実装が無い(nodemailer/SendGrid/Resend等いずれも未導入 —
 * package.jsonのdependenciesを確認済み)。既にAWSベースのインフラ
 * (Amplify/Secrets Manager)を使っている本アプリの構成に合わせ、AWS
 * SES(SESv2 SendEmail)を新規に採用した。
 *
 * 【カスタムヘッダ対応(2026-08-30 WebSearchで確認)】SESv2の
 * SendEmailはSimple contentでもカスタムヘッダを指定できる(2024年3月の
 * アップデートで追加された機能)。In-Reply-To/Referencesはこの機能で
 * 設定できる(SESが自動設定するMessage-ID/From/To/Subject等は
 * カスタムヘッダとして上書きできない、という制約も確認済み)。
 *
 * 【未実装の部分、正直に】
 *   - 送信元メールアドレスの検証(SES Verified Identity)・送信専用
 *     ドメインのDKIM/SPF設定はAWSコンソール側の作業であり、かつ
 *     「どのドメイン/アドレスを使うか」はBELLOの業務判断そのもの
 *     (このアプリが勝手に決めてよいものではない) — 環境変数
 *     EMAIL_SES_FROM_ADDRESSが未設定の間は送信を試みずCONFIG_REQUIRED
 *     エラーを返す(BLOCKED_BY_USER)。
 *   - 受信(SES Receiving→S3→取り込み)は、上記の送信ドメイン検証が
 *     前提になるため今回は未着手(BLOCKED_BY_USER、上記と同じ理由)。
 *     このファイルにはparseInboundEmailのような受信解析ロジックは
 *     まだ無い — 実際にSES Receivingで受信できるドメインが決まって
 *     から実装するのが正しい順序と判断した(存在しない受信経路のための
 *     パーサだけを先に書いても検証しようがなく、憶測実装になるため)。
 */

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2";

let cachedClient: SESv2Client | null = null;
function getClient(): SESv2Client {
  if (!cachedClient) cachedClient = new SESv2Client({ region: REGION });
  return cachedClient;
}

export interface SendEmailReplyParams {
  to: string;
  subject: string;
  body: string;
  /** スレッド化用 — このConversationの直近の受信メールのMessage-Id(§53)。無ければヘッダを付けない(新規スレッドとして送る)。 */
  inReplyToExternalMessageId?: string | null;
}

export async function sendEmailReply(params: SendEmailReplyParams): Promise<void> {
  const fromAddress = process.env.EMAIL_SES_FROM_ADDRESS;
  if (!fromAddress) {
    throw new Error(
      "EMAIL_SES_FROM_ADDRESSが設定されていません。AWS SESで送信元アドレス/ドメインの検証(Verified Identity)を行い、環境変数を設定してください（使用するドメインの選定はADMINの判断が必要です）。",
    );
  }

  const threadingHeaders = buildThreadingHeaders(params.inReplyToExternalMessageId ?? null, []);
  const headers = Object.entries(threadingHeaders).map(([Name, Value]) => ({ Name, Value }));

  try {
    await getClient().send(
      new SendEmailCommand({
        FromEmailAddress: fromAddress,
        Destination: { ToAddresses: [params.to] },
        Content: {
          Simple: {
            Subject: { Data: params.subject, Charset: "UTF-8" },
            Body: { Text: { Data: params.body, Charset: "UTF-8" } },
            Headers: headers.length > 0 ? headers : undefined,
          },
        },
      }),
    );
  } catch (err) {
    const name = err instanceof Error ? err.name : undefined;
    const message = err instanceof Error ? err.message : String(err);
    if (name === "MessageRejected") throw new Error(`SESにメール送信を拒否されました(送信先アドレスの検証状態を確認してください): ${message}`);
    if (name === "AccessDeniedException") throw new Error("AWS SESへの送信権限がありません。実行ロールにses:SendEmailの権限を付与してください。");
    if (name === "CredentialsProviderError" || /could not load credentials/i.test(message)) throw new Error("AWS認証情報を確認できません。");
    throw new Error(`メール送信に失敗しました: ${message}`);
  }
}
