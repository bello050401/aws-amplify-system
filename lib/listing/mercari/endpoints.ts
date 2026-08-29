/**
 * Mercari Shops GraphQL エンドポイント定義(BELLO統合改修 master指示書
 * Phase D — origin/claude/mercari-shops-auto-listing-ag0w6m branchの
 * integrations/mercari-shops/endpoints.tsから移植、ロジック無変更)。
 * URLはこの1箇所のみに書き、他の場所にハードコードしない。
 */

export type MercariEnvironment = "sandbox" | "production";

const ENDPOINTS: Record<MercariEnvironment, string> = {
  sandbox: "https://api.mercari-shops-sandbox.com/v1/graphql",
  production: "https://api.mercari-shops.com/v1/graphql",
};

export function getMercariEnvironment(): MercariEnvironment {
  const raw = (process.env.MERCARI_ENV ?? "sandbox").toLowerCase();
  if (raw === "production") return "production";
  if (raw !== "sandbox") {
    console.warn(`Unknown MERCARI_ENV="${raw}", falling back to "sandbox".`);
  }
  return "sandbox";
}

export function getMercariEndpoint(env: MercariEnvironment = getMercariEnvironment()): string {
  return ENDPOINTS[env];
}

/**
 * BELLO統合改修 master指示書(2026-08-29統合改修版) §7/§17: 実際に報告
 * されたMercari Shops API HTTP 404の根本原因調査。
 *
 * このround開始時点ではエンドポイントURL自体(上のENDPOINTS)が
 * [UNVERIFIED]としてマークされていたが、WebSearch経由でMercari Shops
 * API公式ドキュメント(https://api.mercari-shops.com/docs/index.html —
 * このsandbox環境からは直接WebFetchできない対象ドメインだが、検索結果
 * の要約からは実際の記載内容を確認できた)を調査した結果、URLそのもの
 * (production/sandboxとも)は公式ドキュメントの記載と一致しており、
 * 誤りではないことを確認した(Q7「404を安易にtoken不良と決めつけず、
 * 実際のendpoint/version/request形状を先に検証する」への対応)。
 *
 * 一方で、その公式ドキュメントには明確にこう書かれていた: 「開発環境・
 * 本番環境の両方で、すべてのリクエストへ正しいUser-Agentヘッダを設定
 * しなければならない。Mercariは2024年中に、正しいUser-Agentを指定しな
 * いリクエストを制限する計画だった」。フォーマットは
 * `{API_CLIENT_NAME}/{VERSION}` — API_CLIENT_NAMEは契約時にMercari側
 * から利用企業ごとに割り当てられる値、VERSIONは呼び出し側が任意に決め
 * てよい文字列(特に無ければ固定で"0.0.0")。
 *
 * ところがlib/listing/mercari/client.tsのこれまでの実装は
 * Content-Type/Authorizationの2つしかヘッダを送っておらず、
 * User-Agentを一切送っていなかった。多くのAPI Gateway/CDN(Cloudflare
 * 含む)は必須ヘッダを欠くリクエストをルーティング/WAF層で弾き、その
 * 際400/401ではなく404を返す設定になっていることがある — これは実際
 * に報告されたHTTP 404の、推測ではなく公式ドキュメントの記述に基づい
 * た有力な根本原因候補である(唯一の原因と断定はしない — この
 * sandbox環境からMercari本番/sandbox APIへ実際にリクエストを送って
 * 最終確認する手段が無いため、実際に404が解消するかどうかの実証は
 * できていない。完了報告ではLOCAL_IMPLEMENTEDに留め、
 * REAL_EXTERNAL_API_VERIFIEDとは呼ばない)。
 *
 * MERCARI_API_CLIENT_NAMEはMercariとの契約時に個社へ割り当てられる値
 * であり、この値をこちらで推測・捏造することは絶対にできない(捏造し
 * た値を送っても正しいUser-Agentを送ったことにはならず、根本原因の
 * 修正にならないうえ、Mercari側からの信頼を損ねる恐れすらある) —
 * 未設定の場合はgetMercariUserAgentが明確なエラーを投げ、Mercari側の
 * 管理画面/契約担当者へ確認するよう促す(CONFIG_REQUIRED、決して黙っ
 * て仮の値でリクエストを送らない)。
 */
/** MERCARI_API_CLIENT_NAMEはtoken同様の秘匿値ではない(Mercariとの契約上の識別名であって認証情報そのものではない)ため、値自体を設定画面へ表示しても問題ない — が、まずは「設定済みかどうか」の真偽値だけをMercariSettingsPanel.tsxへ渡す(getMercariUserAgentのCONFIG_REQUIREDエラーを、出品を試すまで気付けない状態にしないため)。 */
export function isMercariApiClientNameConfigured(): boolean {
  return Boolean(process.env.MERCARI_API_CLIENT_NAME?.trim());
}

export function getMercariUserAgent(): string {
  const clientName = process.env.MERCARI_API_CLIENT_NAME?.trim();
  if (!clientName) {
    throw new Error(
      "MERCARI_API_CLIENT_NAMEが設定されていません。Mercari Shopsとの契約時に割り当てられたAPIクライアント名を、サーバー環境変数MERCARI_API_CLIENT_NAMEへ設定してください（Mercari公式ドキュメントによれば、正しいUser-Agentヘッダを送らないリクエストは拒否されます。値の割り当てについてはMercari Shopsの契約担当窓口へご確認ください）。",
    );
  }
  const version = process.env.MERCARI_API_CLIENT_VERSION?.trim() || "0.0.0"; // Mercari公式ドキュメントの既定値どおり — 特にバージョン管理していない場合の固定値
  return `${clientName}/${version}`;
}
