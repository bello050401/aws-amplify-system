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
 * BELLO統合業務OS指示書(2026-08-30) §28: 「Mercari
 * docsにあるstatic outbound IP記載が『Mercari webhook送信元IP』なのか
 * 『APIクライアントのIP allowlist要件』なのかを混同しないこと」への
 * 調査結果。
 *
 * WebSearchで確認できた内容(公式ドキュメント本文はこのsandbox環境から
 * api.mercari-shops.comへ直接到達できず、検索結果の要約経由): Mercari
 * Shops公式ドキュメントに記載されている固定IPアドレス(CIDR表記、2025年
 * 8月に新しいレンジへ更新された、という更新履歴あり)は、**Mercari
 * 自身がWebhookを送信してくる送信元IP**であり、Webhook受信側
 * (今回でいえばBELLO側)がファイアウォール/allowlistでその送信元を
 * 検証するためのものだった。BELLOがMercari
 * GraphQL APIへ発信するリクエスト(このファイルのgetMercariEndpoint宛
 * 通信)側に固定送信元IPを要求する記載は見つからなかった。
 *
 * 結論: BELLO→Mercari
 * のAPI発信経路に固定IP(NAT Gateway等の継続コストがかかる構成)は不要
 * ——
 * 必要になるのはむしろ将来Mercariの問い合わせWebhookを受信する場合
 * (§39以降のMessage機能)で、その際はBELLO側のWebhookエンドポイントが
 * 受信リクエストの送信元IPをこのCIDRレンジと突き合わせて検証する、
 * という逆方向の使い方になる。§125(AWS
 * cost)の「固定IPが不要なら作らない」を満たすため、現時点でNAT
 * Gateway等は導入していない。[UNVERIFIED: 公式ドキュメント本文へ直接
 * 到達できていないため、実際のCIDRレンジ値そのものはこのコメントには
 * 転記していない — Webhook実装時に改めて公式ドキュメントで確認するこ
 * と。]
 */

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
/** Mercari公式ドキュメントの既定値どおり — 特にバージョン管理していない場合の固定値。 */
export const MERCARI_DEFAULT_CLIENT_VERSION = "0.0.0";

/**
 * BELLO統合業務OS指示書(2026-08-30) §24/§26: APIクライアント名の解決
 * (Secrets Manager優先・環境変数フォールバック、TOKENと同じ経路)は
 * lib/listing/mercari/tokenAccess.tsのgetMercariUserAgent/
 * getMercariClientNameConfig/isMercariApiClientNameConfiguredへ移した
 * (このファイルはAWSに触れない、純粋なローカル設定/フォーマットだけを
 * 置く場所という位置づけを保つため)。ここに残すのは、実際に
 * clientName/versionが揃った後の「User-Agent文字列を組み立てる」だけの
 * 副作用フリーな純関数 — scripts/verify-listing.tsがAWSに一切触れずに
 * フォーマットの正しさだけを検証できるようにするため、意図的に分離して
 * いる。
 */
export function formatMercariUserAgent(clientName: string, version: string = MERCARI_DEFAULT_CLIENT_VERSION): string {
  return `${clientName}/${version}`;
}
