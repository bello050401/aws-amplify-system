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
