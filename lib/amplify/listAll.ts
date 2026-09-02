import "server-only";

/**
 * Amplify Data の `list()` を **最後のページまで辿る** ための共通ヘルパー。
 *
 * ── なぜ必要か(実測した根本原因) ──────────────────────────────────
 *
 * DynamoDB の `Limit` は「フィルタを適用する前に読む件数」の上限であって
 * 「条件に合致した件数」ではない。AppSync/Amplify の `list({ filter })`
 * はこれをそのまま反映するため、
 *
 *     list({ filter: { rank: { eq: "C" } } })   // limit 未指定 = 既定100
 *
 * は「先頭100行を読み、そのうち rank=C だったものだけ」を1ページとして
 * 返す。**条件に合う行が他に何件あっても、次ページを辿らない限り返らない。**
 *
 * 2026-09-02 に Staging の実データで再現した値:
 *
 *     ShippingRate 総数 450(9ランク × 50地域、欠損なし)
 *     [Limit=100 + Filter rank=C] returned=10 / scanned=100 / hasMore=true
 *       → 含まれる代表地域: 東京都=false 愛知県=false 大阪府=true
 *
 * これが「EC出品画面の地域別送料で 東京=データ不足 / 名古屋圏=データ不足 /
 * 大阪圏=¥9,460 と表示される」の正体だった。DBには450件すべて揃っていて、
 * 読み方だけが間違っていた。同じ条件で `lookupShippingRate`(都道府県+
 * ランクの2条件)は **東京都/C・愛知県/C で0件を返す** ——AI返信の送料
 * 参照もここで静かに失敗していた。
 *
 * これは以前 ProcessingJob の PENDING 取りこぼし
 * (docs/night-work-20260902.md §8)で踏んだのと**同じ種類**の不具合で、
 * 個別に直すのではなく、フィルタ付きの一覧取得が共通で使える形にする。
 *
 * ── 設計 ──────────────────────────────────────────────────────────
 *
 * - 「合致0件のページ」で打ち切らない。DynamoDB は合致0件でも
 *   nextToken を返すことがあり(上の実測がまさにそれ)、そこで止めると
 *   取りこぼす。**nextToken が null になるまで**辿る。
 * - 上限ページ数に達したら **黙って打ち切らずに例外を投げる**。
 *   「全件のつもりが実は途中まで」を静かに作らない。
 * - errors を無視しない。
 */

export interface AmplifyListPage<T> {
  data: T[];
  nextToken?: string | null;
  errors?: { message: string }[];
}

export interface ListAllOptions {
  /**
   * 安全弁。ここに達したら例外。既定は200ページ ——
   * 1ページ1,000件なら20万件まで辿れる計算で、BELLOの現在の最大テーブル
   * (Inventory 5,313件)の桁を大きく上回る。
   */
  maxPages?: number;
  /** 例外メッセージに出す対象名(例: "ShippingRate")。 */
  label?: string;
}

export async function listAllPages<T>(
  fetchPage: (nextToken: string | undefined) => Promise<AmplifyListPage<T>>,
  options: ListAllOptions = {},
): Promise<T[]> {
  const maxPages = options.maxPages ?? 200;
  const label = options.label ?? "一覧";
  const out: T[] = [];
  let nextToken: string | undefined;
  let pages = 0;

  do {
    const page = await fetchPage(nextToken);
    if (page.errors && page.errors.length > 0) {
      throw new Error(`${label}の取得に失敗しました: ${page.errors.map((e) => e.message).join("; ")}`);
    }
    out.push(...page.data);
    nextToken = page.nextToken ?? undefined;
    pages++;
    if (nextToken && pages >= maxPages) {
      // 打ち切って「これで全部です」と返すのが一番危険。呼び出し元が
      // 部分的な集合を全体だと思って判断してしまう。
      throw new Error(
        `${label}の取得が${maxPages}ページの上限に達しました(${out.length}件取得済み、まだ続きがあります)。取得条件を見直してください。`,
      );
    }
  } while (nextToken);

  return out;
}
