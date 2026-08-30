/**
 * 日時の表示は必ず日本時間(Asia/Tokyo)で行うためのフォーマッタ。
 *
 * ## なぜ必要か(実測した不具合)
 *
 * `new Date(iso).toLocaleDateString("ja-JP")` は**実行環境の**タイム
 * ゾーンで日付を出す。Amplify HostingのSSRコンピュートはUTCで動くのに
 * ブラウザは日本時間なので、同じ値がサーバーとクライアントで別の文字列
 * になり、React 18のhydrationが壊れる。実際に在庫一覧で
 *
 *   Warning: Text content did not match.
 *   Server: "2026/8/31"  Client: "2026/8/30"
 *
 * が出ており、本番ビルドでは Minified React error #425 として
 * pageerrorになっていた(UTCの15:00以降＝日本時間の翌日、に更新された
 * レコードが一覧に出ているときだけ再現する — つまり日本の営業時間帯に
 * 更新した商品ほど当たりやすい)。
 *
 * ## 方針
 *
 * 「今日」「今月」の判定を全てJST基準で行う既存方針(sales.tsの
 * `nowInJst`)と揃え、**表示側もJSTで固定**する。タイムゾーンを明示すれ
 * ば、サーバーでもブラウザでも同じ文字列になるのでhydrationは一致し、
 * かつ利用者にとって正しい日本時間が出る。
 */

const DATE_FMT = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

const DATE_TIME_FMT = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** 壊れた/空のISO文字列でも画面を落とさない — 一覧の1セルのために全体が落ちる方が悪い。 */
function safe(value: string | null | undefined, fmt: Intl.DateTimeFormat): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return fmt.format(d);
}

/** 例: 2026/8/31 */
export function formatJstDate(value: string | null | undefined): string {
  return safe(value, DATE_FMT);
}

/** 例: 2026/8/31 09:05 */
export function formatJstDateTime(value: string | null | undefined): string {
  return safe(value, DATE_TIME_FMT);
}
