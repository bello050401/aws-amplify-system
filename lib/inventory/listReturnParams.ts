/**
 * QA005: 一覧→詳細→(一覧へ戻る)で検索条件が消える不具合の修正。
 *
 * 一覧ページの許可された検索/ページング条件(q/categoryIds/locationId/
 * statusId/advanced/adv/offset/limit)を、詳細ページへのリンクに1つの
 * `from` クエリパラメータとして埋め込み、詳細ページ側で読み戻して
 * 「在庫一覧へ戻る」のhrefを組み立て直すための、依存ゼロの純粋関数群。
 *
 * 依存ゼロにしているのは実装上の都合ではない —— このリポジトリのテスト
 * 実行環境(dev-orchestratorのworktree)には node_modules が無く、
 * server-only/next/reactに依存するモジュールは実行して検証できない
 * (docs参照)。ここを純粋関数に寄せることで、素のnodeだけで
 * 挙動を実行検証できるようにしてある。
 *
 * セキュリティ上の要点: `from` の値をそのまま戻り先URLとして使わない。
 * 常に "/inventory" 固定 + ここで許可した8キーだけをURLSearchParamsで
 * 再構築したクエリ文字列、という組み立て方しかしないため、`from` に
 * 何を入れられても(外部URL・別パス・任意文字列)遷移先は必ず
 * "/inventory" または "/inventory?<許可キーのみ>" にしかならない —
 * オープンリダイレクトにも任意パス遷移にもならない。
 */

/** 一覧側で検索条件の復元に使う、URL上のキー一覧(この配列が唯一の許可リスト)。 */
const ALLOWED_KEYS = ["q", "categoryIds", "locationId", "statusId", "advanced", "adv", "offset", "limit"] as const;

type AllowedKey = (typeof ALLOWED_KEYS)[number];

type ListReturnSource = Partial<Record<AllowedKey, string | undefined>>;

/**
 * 一覧ページの searchParams から、戻り先の復元に要る値だけを拾って
 * 正規化したクエリ文字列を作る。該当する値が1つも無ければ空文字列
 * (=詳細URLに `from` を付けない)。
 */
export function buildListReturnQuery(searchParams: ListReturnSource): string {
  const sp = new URLSearchParams();
  for (const key of ALLOWED_KEYS) {
    const value = searchParams[key];
    if (value) sp.set(key, value);
  }
  return sp.toString();
}

/**
 * 一覧→詳細リンクのhref。`listReturnQuery` が空(=通常一覧・検索条件
 * 無し、または詳細への直リンク元に一覧が無いケース)なら、従来どおり
 * 素の "/inventory/{id}" のまま —— 詳細URLを不必要に汚さない。
 */
export function buildDetailHref(id: string, listReturnQuery: string): string {
  return listReturnQuery ? `/inventory/${id}?from=${encodeURIComponent(listReturnQuery)}` : `/inventory/${id}`;
}

/**
 * 詳細ページが受け取った生の `from` (= Next.jsのsearchParamsとして
 * 既に1段階URLデコード済みの値)を、許可キーだけのクエリ文字列へ
 * 再構築する。壊れた値・改ざんされた値・URLの体をなさない値は、例外を
 * 投げずに「該当キー無し」として扱う——一覧側のparseAdvancedQueryと
 * 同じ「壊れたURLはエラー画面にせず無視する」方針。
 */
function sanitizeListReturnParam(rawFrom: string | undefined): string {
  if (!rawFrom) return "";
  let parsed: URLSearchParams;
  try {
    parsed = new URLSearchParams(rawFrom);
  } catch {
    return "";
  }
  const sp = new URLSearchParams();
  for (const key of ALLOWED_KEYS) {
    const value = parsed.get(key);
    if (value) sp.set(key, value);
  }
  return sp.toString();
}

/**
 * 詳細ページの「在庫一覧へ戻る」に使うhref。`rawFrom` が無い・壊れて
 * いる・許可キーを1つも含まない場合は、素の "/inventory"(検索条件
 * 無しの通常一覧)にフォールバックする —— 詳細への直リンクや、改ざん
 * された `from` はここに落ちる。
 */
export function buildBackToListHref(rawFrom: string | undefined): string {
  const query = sanitizeListReturnParam(rawFrom);
  return query ? `/inventory?${query}` : "/inventory";
}

/**
 * 詳細ページが受け取った `from` を、詳細配下の別画面(編集画面など)
 * へのリンク/リダイレクト先にもそのまま引き継ぐためのhrefを作る。
 * 戻り先そのものは常に `basePath` 固定 —— `from` の中身によって
 * `basePath` 自体が書き換わることはない。
 */
export function appendReturnParam(basePath: string, rawFrom: string | undefined): string {
  const query = sanitizeListReturnParam(rawFrom);
  return query ? `${basePath}?from=${encodeURIComponent(query)}` : basePath;
}
