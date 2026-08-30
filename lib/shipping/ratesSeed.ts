import "server-only";

/**
 * BELLO統合業務OS指示書(2026-08-30) §61-66: 家財おまかせ便の実料金
 * 調査結果と、このラウンドで投入した初期データについての記録。
 *
 * 【実施した調査】(WebFetchはこのsandbox環境のegress proxyにより
 * antique-alver.com/www.rakuten.ne.jp等の候補サイトへ到達できず
 * EGRESS_BLOCKEDで失敗 — Mercari調査時と同じ制約)。WebSearch
 * (サーバー側フェッチ経由の要約を返す)で複数クエリを実行:
 *   - "家財おまかせ便 料金表 ランク SS S A B C D 円"
 *   - "アートセッティングデリバリー 家財おまかせ便 埼玉 発送 料金 円 税込"
 *   - "kazai_list.pdf ヤマト 関東 埼玉 Bランク Cランク Dランク 円"
 *   - "viviandcoco kazai.html 料金表 関東 Aランク..Gランク"
 *   - "raku1.co.jp 家財おまかせ便送料表 ランク 円"
 *   - "des-moa.com 家財おまかせ便 料金 ランク..."
 *
 * 【確認できたこと】
 *   - ランクは3辺合計(cm)で9段階(SS〜G)、指示書§63の閾値と整合。
 *   - 発地/着地の都道府県(地域)によって同ランクでも金額が変わる
 *     (地域区分の詳細な線引きは確認できず — 都道府県単位の実例のみ)。
 *   - F/Gランクは地域限定配送で要事前確認、繁忙期加算が別途存在する
 *     (金額は未確認)。
 *   - 実例として、埼玉→東京のルートで:
 *       Bランク(3辺合計200cm以内) = ¥4,510(税込)
 *       Cランク(3辺合計250cm以内) = ¥7,740(税込)
 *     という具体的な数値がWebSearch要約から得られた
 *     (出典: WebSearchクエリ「アートセッティングデリバリー 家財おまか
 *     せ便 埼玉 発送 料金 円 税込」、2026-08-30に確認)。
 *
 * 【確認できなかったこと(未実装の理由)】
 *   - 埼玉発の他ランク(SS/S/A/D/E/F/G)・他都道府県着の金額表全体。
 *   - 公式の料金検索ツール(form.008008.jp)はJavaScriptフォーム/
 *     セッション経由の動的な見積りツールであり、単純なURL fetchでは
 *     結果を取得できない(§117: 「単にHTTP errorだったから無理、と
 *     しない」を踏まえ複数クエリを試したが、このsandbox環境の
 *     WebFetchは候補サイトすべてでEGRESS_BLOCKEDとなり、フォーム入力
 *     を伴う実際のUIフローを辿る手段が無い)。
 *
 * 【第二次完全完遂指示(2026-08-30)での再調査】form.008008.jpへの
 * WebFetch直接試行(初期画面のフォーム構造・POSTパラメータ確認目的)を
 * 再度行ったが、同じくEGRESS_BLOCKEDで到達不可。追加のWebSearchで
 * 「北海道(道東・道北・札幌／千歳・函館の3エリア)＋46都道府県分の
 * 料金表が提供されている」こと(=表自体は存在し、当該47都道府県超の
 * 粒度で構成されていること)・地域区分が「地域Ⅰ〜Ⅺ」の11区分である
 * ことを追加確認したが、表の実数値(価格)はWebSearchの要約経由では
 * 取得できなかった(検索エンジンがJS動的レンダリングされた料金表の
 * 中身までは要約してくれないため)。技術的な取得手段(WebFetchの
 * egress許可)が無いことが根本原因であり、調査を怠ったためではない。
 *
 * 【今回の対応】ShippingRateはDBマスタとして設計し(スキーマ・CRUD・
 * ルックアップロジックは完全に実装済み)、実データは上記で実際に確認
 * できた2件(埼玉→東京、B/Cランク)だけを検証済みとして投入する。
 * それ以外のランク・着地は空のまま(ADMINが設定画面から実際の料金
 * 検索結果を見ながら入力する運用 — sourceReference/verifiedAtを
 * 必須に近い形でUIに持たせているのはこのため)。憶測の金額を埋めて
 * 「実装完了」に見せかけることはしない(§157 fake success禁止)。
 *
 * 完了報告での分類: 家財おまかせ便レート表本体はBLOCKED_BY_EXTERNAL_SERVICE
 * (公式料金検索ツールが動的フォームでこのsandbox環境から到達不可のため)
 * だが、上記2件のみ実際にWebSearchで確認できた値としてLOCAL_IMPLEMENTED
 * (ランク判定ロジック・マスタ管理・見積りUI・AI返信連携の枠組みは
 * すべて完成しており、料金データの拡充だけがADMIN作業として残る)。
 */
export const SHIPPING_RATE_SEED_SOURCE_REFERENCE =
  "WebSearch「アートセッティングデリバリー 家財おまかせ便 埼玉 発送 料金 円 税込」(2026-08-30確認、公式サイトの一次情報への直接到達はsandbox環境の制約により不可)";

export const SHIPPING_RATE_SEED_VERIFIED_AT = "2026-08-30T00:00:00.000Z";

export interface ShippingRateSeedRow {
  provider: string;
  service: string;
  originPrefecture: string;
  destinationPrefecture: string;
  rank: "B" | "C";
  price: number;
}

/** §66調査で実際に確認できた2件のみ。他は憶測で埋めない。 */
export const SHIPPING_RATE_SEED: ShippingRateSeedRow[] = [
  { provider: "アートセッティングデリバリー", service: "家財おまかせ便", originPrefecture: "埼玉県", destinationPrefecture: "東京都", rank: "B", price: 4510 },
  { provider: "アートセッティングデリバリー", service: "家財おまかせ便", originPrefecture: "埼玉県", destinationPrefecture: "東京都", rank: "C", price: 7740 },
];
