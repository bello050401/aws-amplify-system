/**
 * BASE OAuthで要求するスコープ。
 *
 * 【なぜ設定可能である必要があるか】BELLOのBASE出品機能
 * (lib/listing/base/adapter.ts の items/add・items/edit)は `write_items`
 * を要る。しかしBASE Developers側でアプリに「商品情報を更新する」権限を
 * 許可していない場合、`write_items` を要求すると **認可そのものが通らず、
 * 読み取りすらできなくなる**。権限の追加はBASE側の操作なので、
 * こちらでそれを待たずに読み取りだけ先に成立させられるようにする。
 *
 * oauth.ts ではなくここに置いているのは、oauth.ts が
 * Amplify Data クライアント(AWS接続)をimportしており、
 * この純粋関数だけを単体検証したい（scripts/verify-base.ts）ため。
 */

/** BASE公式の全スコープのうち、BELLOが使うもの。 */
export const READ_WRITE_SCOPE = "read_items write_items";
/**
 * BASE Developers側の利用権限が閲覧系だけの場合に使う。
 * 商品説明分析・特集ページ作成はこれで足りる（出品と価格変更だけが
 * write_items を要る）。
 */
export const READ_ONLY_SCOPE = "read_items";

/**
 * @param requestWriteItems 設定画面のチェックボックスの状態。
 * 環境変数 `BASE_SCOPES` は明示的な上書きとして最優先で尊重する
 * （運用中に一時的に別のスコープで繋ぎ直す必要が出た場合の逃げ道）。
 */
export function resolveScope(requestWriteItems: boolean): string {
  const override = process.env.BASE_SCOPES?.trim();
  if (override) return override;
  return requestWriteItems ? READ_WRITE_SCOPE : READ_ONLY_SCOPE;
}
