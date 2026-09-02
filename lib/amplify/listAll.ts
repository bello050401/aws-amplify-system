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

/**
 * `list()` の結果から配列を取り出す。GraphQLエラーが乗っていたら**投げる**。
 *
 * ── なぜ要るのか(Amplifyランタイムの実装) ──────────────────────
 *
 * @aws-amplify/data-schema の handleListGraphQlError は、list系の
 * 呼び出しでGraphQLエラーが起きたとき **`data: []` を返す**:
 *
 *     function handleListGraphQlError(error) {
 *       if (error?.errors) {
 *         return { ...error, data: [] };   // ← エラーが空配列になる
 *       } else {
 *         throw error;                     // ネットワーク等はthrow
 *       }
 *     }
 *
 * つまり `const { data } = await ...list(...)` と書いて `errors` を見ない限り、
 * 認可拒否・indexの不在・スロットリングが、呼び出し側からは
 * **「該当0件」と完全に区別が付かない**。
 *
 * これは既存の原則(§13.2「エラーや取りこぼしを0件と混同しない」)に
 * 真っ向から反する。とくに危ないのは次の2種類:
 *
 *   重複を防ぐ判定  … 「既にあるか」を空で受け取ると、もう1件作る
 *   削除の可否判定  … 「使われているか」を0で受け取ると、使用中でも消す
 *
 * どちらも失敗したときに**開く**方向へ倒れる。閉じる方向へ倒す。
 */
export function unwrapList<T>(
  result: { data: T[]; errors?: { message: string }[] },
  label: string,
): T[] {
  if (result.errors && result.errors.length > 0) {
    throw new Error(`${label}の取得に失敗しました: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  return result.data;
}

/** 単数(get)版。「見つからない」(data===null かつ errors無し)は正常な結果として null を返す。 */
export function unwrapGet<T>(
  result: { data: T | null; errors?: { message: string }[] },
  label: string,
): T | null {
  if (result.errors && result.errors.length > 0) {
    throw new Error(`${label}の取得に失敗しました: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  return result.data;
}

/**
 * 書き込み(create / update / delete)の結果を取り出す。エラーが乗っていたら投げる。
 *
 * ── 読み取りとは失敗の意味が違う ────────────────────────────────
 *
 * 読み取りで errors を無視すると「0件」に化ける。書き込みで無視すると
 * **「成功した」ことになる**。呼び出し側はそのまま次の処理へ進み、
 * 画面には完了と出る。実際には何も保存されていない。
 *
 * Amplify は書き込みでも例外を投げず `{ data: null, errors: [...] }` を
 * 返すので、`await ...update(...)` と書いて戻り値を捨てると、認可拒否も
 * 条件付き書き込みの失敗も、何事も無かったように通過する。
 *
 * ── data の null は投げない ─────────────────────────────────────
 *
 * errors が無くて data が null になるのは delete で「元々無かった」場合。
 * これは異常ではないので、null をそのまま返して呼び出し側に委ねる。
 */
export function unwrapWrite<T>(
  result: { data: T | null; errors?: { message: string }[] },
  label: string,
): T | null {
  if (result.errors && result.errors.length > 0) {
    throw new Error(`${label}の保存に失敗しました: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  return result.data;
}

/** unwrapWrite と同じだが、書き込んだ行が返ってくることを要求する。create / update 向け。 */
export function unwrapWriteRequired<T>(
  result: { data: T | null; errors?: { message: string }[] },
  label: string,
): T {
  const data = unwrapWrite(result, label);
  if (!data) throw new Error(`${label}の保存に失敗しました（保存後の行を読み戻せませんでした）。`);
  return data;
}
