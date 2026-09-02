/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // BASE serves item images from more than one Akamai-fronted host —
    // confirmed via a real /1/items response returning base-ec2.akamaized.net
    // (see extractImageUrls in lib/base/client.real.ts and
    // docs/NOTES_BASE_API.md), while the public shop page itself references
    // baseec-img-mng.akamaized.net. Both are allowed rather than guessing
    // which one a given account/region gets.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "baseec-img-mng.akamaized.net",
      },
      {
        protocol: "https",
        hostname: "base-ec2.akamaized.net",
      },
    ],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
    // instrumentation.ts を有効にする。Next.js 14 では experimental 扱い。
    // 目的と出力内容は instrumentation.ts の冒頭コメントに書いてある
    // (SSRログがCloudWatchへ届いているかを確定させるための1行だけ)。
    instrumentationHook: true,
  },

  /**
   * LINE webhookの受信保存が使うDynamoDBテーブル名を、ビルド時に
   * サーバーバンドルへ埋め込む。
   *
   * ## なぜ必要か(推測ではなく実測)
   *
   * Amplifyコンソールに設定した環境変数は**ビルドには渡るが、Next.jsの
   * SSRランタイムのprocess.envには現れない**。Stagingへ正しい署名付きの
   * 本物のwebhookリクエストを送ったところ、CONVERSATION_TABLE_NAME /
   * MESSAGE_TABLE_NAME をコンソールに設定済みであるにもかかわらず
   *   500 {"ok":false,"failed":1,"reasons":["TABLE_NOT_CONFIGURED"]}
   * が返った(2026-08-31、job 105)。実行時には両方とも空だった。
   *
   * ## なぜ .env.production ではなくここか
   *
   * amplify.ymlの `artifacts.baseDirectory` は `.next` で、リポジトリ
   * 直下に書き出した `.env.production` が実行環境まで運ばれる保証が無い。
   * 一方この `env` はwebpackのDefinePluginでビルド時に**リテラルへ置換**
   * されるため、.next の中だけが配られても値が残る。
   *
   * ## 制約
   *
   * 値はビルド成果物へ焼き込まれる。Amplify側の環境変数を変えたときは
   * 再ビルドが要る。テーブル名は秘密情報ではないので焼き込んで問題ない。
   * **TOKEN類は絶対にここへ書かない** — 従来どおりSecrets Managerから
   * 実行時に取得する(lib/zaico/secretStore.ts等)。
   *
   * 未設定のブランチではキーが省かれ、実行時は undefined のままになる。
   * その場合はwebhookが TABLE_NOT_CONFIGURED を返すので原因が分かる。
   */
  env: {
    ...(process.env.CONVERSATION_TABLE_NAME ? { CONVERSATION_TABLE_NAME: process.env.CONVERSATION_TABLE_NAME } : {}),
    ...(process.env.MESSAGE_TABLE_NAME ? { MESSAGE_TABLE_NAME: process.env.MESSAGE_TABLE_NAME } : {}),
    // Mercari中継サーバーのURL。**秘密値ではない**(共有鍵とCAはSecrets
    // Managerにある)。Amplifyの環境変数はSSRランタイムのprocess.envへ届かない
    // ため、上の2つと同じくビルド時にここでリテラルへ埋め込む。
    ...(process.env.MERCARI_RELAY_URL ? { MERCARI_RELAY_URL: process.env.MERCARI_RELAY_URL } : {}),
    // AgentCore Web Search GatewayのURL。これも**秘密値ではない**
    // (認可はIAM。APIキーは存在しない)。同じ理由でビルド時に埋め込む。
    ...(process.env.AGENTCORE_GATEWAY_URL ? { AGENTCORE_GATEWAY_URL: process.env.AGENTCORE_GATEWAY_URL } : {}),
  },

  /**
   * セキュリティヘッダー。実機(Staging)のレスポンスを確認したところ、
   * HSTS・X-Frame-Options・X-Content-Type-Options・Referrer-Policy の
   * いずれも付いていなかった。認証済みセッションで在庫・売上・顧客
   * メッセージを扱う画面なので、最低限のものだけ足す。
   *
   * Content-Security-Policy は**意図的に入れていない**。この画面は
   * Cognito・AppSync・S3(署名付きURL)・Amplifyのインラインスクリプトへ
   * 同時に依存しており、許可元を実測で洗い出さないまま付けると本番で
   * 静かに壊れる。付けるなら別途、実際の通信先を列挙してからにする。
   *
   * frame-ancestorsの代わりに X-Frame-Options: DENY を使う — この
   * アプリを他サイトへ埋め込む用途は無く、clickjacking(操作の乗っ取り)
   * を防ぐのに追加の調査が要らないため。
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Amplify HostingはHTTPSのみで配信するため、HSTSを付けても
          // HTTPでの到達手段を失わない。
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          // 使っていないブラウザ機能は既定で無効にしておく。
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
