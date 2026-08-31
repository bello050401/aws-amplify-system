/**
 * ZAICO全件取得のページ反復（2026-08-31 統合仕様書 §6 / 最終仕上げ指示書 §3）。
 *
 * ## 「1,000件で止まる」の調査結果
 *
 * 仕様書は「固定の1,000件上限を撤廃せよ」と要求しているが、コードを
 * 全走査した結果、**同期経路に件数の固定上限は存在しなかった**。
 * `1000` というリテラルはコメント2箇所にあるだけで、
 * `maxPages` `maxItems` `take` `slice` に相当する打ち切りも無い。
 * 3つの経路（`syncAllZaicoItems` / `advanceZaicoBackgroundSyncJob` /
 * Lambda worker）はいずれも
 *
 *   listInventories(page, perPage) → { items, hasMore }
 *   hasMore = items.length === perPage
 *
 * という契約で、`hasMore` が偽になるまで回る。したがって実測で
 * 1,000件だったのは、**ZAICOアカウントの実在庫数がその時点で1,000件
 * だったから**という可能性が高い（ZAICO APIへ実際にページを要求して
 * 確かめる必要があり、それは別途行う）。
 *
 * ## それでも足りていなかったもの
 *
 * 上限は無かった一方、仕様が同時に求めている安全装置が無かった。
 *
 *   - 無限ページ取得の防止（APIが常に満杯ページを返し続けたら止まらない）
 *   - 同じページを繰り返し取得していることの検知
 *   - 何ページ取得したかの計測
 *
 * ここはその3つを持つ共有の反復処理で、**件数の上限としては機能しない**。
 * ページ上限に達した場合は正常終了ではなく `PAGE_LIMIT` として返し、
 * 呼び出し側が異常として扱えるようにしてある（仕様 §3.6
 * 「安全装置をユーザー在庫件数の上限として使ってはいけない」）。
 *
 * ## メモリ
 *
 * 取得したページを配列へ溜め込まない。`onPage` でページ単位に処理させ、
 * この関数自身は件数とページ数しか保持しない（仕様 §3.3
 * 「大量件数でもメモリを不必要に消費しない」）。
 */

export interface ZaicoPage<T> {
  items: T[];
  hasMore: boolean;
}

/** 1ページ取得する関数。実装（lib/zaico/client.ts の listInventories 等）を差し込む。 */
export type FetchPage<T> = (page: number, perPage: number) => Promise<ZaicoPage<T>>;

export type PaginationStopReason =
  /** `hasMore` が偽になった。正常な最終ページ。 */
  | "LAST_PAGE"
  /** 空ページが返った。正常終了として扱う（末尾が丁度割り切れる場合など）。 */
  | "EMPTY_PAGE"
  /** 直前と同じ内容のページが返った。APIかページ指定の異常。 */
  | "DUPLICATE_PAGE"
  /** ページ上限に達した。**正常終了ではない**。 */
  | "PAGE_LIMIT"
  /** 呼び出し側が中断を要求した。 */
  | "ABORTED";

export interface PaginationSummary {
  /** 実際に取得したページ数。 */
  pages: number;
  /** 取得した総件数。 */
  items: number;
  stopReason: PaginationStopReason;
  /** `stopReason` が正常終了（LAST_PAGE / EMPTY_PAGE / ABORTED）かどうか。 */
  completed: boolean;
}

export interface PaginateOptions<T> {
  perPage?: number;
  /**
   * 暴走防止のページ上限。**在庫件数の上限ではない。**
   *
   * 既定4,000ページ = perPage 50 なら20万件。ZAICOの想定規模を大きく
   * 上回る値を置いてあり、ここへ到達するのは「APIが満杯ページを返し
   * 続けている」異常時だけ。到達したら PAGE_LIMIT を返し、呼び出し側が
   * 失敗として報告できるようにする（黙って打ち切らない）。
   */
  maxPages?: number;
  /** 1ページぶんの処理。ここで同期を行い、配列を溜めない。 */
  onPage: (items: T[], page: number) => Promise<void> | void;
  /**
   * ページ内容の指紋。同じページを繰り返し取得していないかの検知に使う。
   * 既定は先頭・末尾要素のJSONと件数。ZAICOの在庫はidを持つので、
   * 呼び出し側がidだけを使う軽い実装を渡してもよい。
   */
  signature?: (items: T[]) => string;
  /** trueを返すと中断する。UIからのキャンセル等。 */
  shouldAbort?: () => boolean | Promise<boolean>;
}

export const DEFAULT_PER_PAGE = 50;
export const DEFAULT_MAX_PAGES = 4000;

function defaultSignature(items: unknown[]): string {
  if (items.length === 0) return "empty";
  return `${items.length}:${JSON.stringify(items[0])}|${JSON.stringify(items[items.length - 1])}`;
}

/**
 * 最終ページまで辿る。件数の上限は設けない。
 *
 * 停止条件は次のいずれかで、どれで止まったかを必ず返す。
 *   - `hasMore` が偽（LAST_PAGE）
 *   - 空ページ（EMPTY_PAGE）
 *   - 直前と同じ内容のページ（DUPLICATE_PAGE、異常）
 *   - ページ上限（PAGE_LIMIT、異常）
 *   - 呼び出し側の中断（ABORTED）
 */
export async function paginateAll<T>(fetchPage: FetchPage<T>, options: PaginateOptions<T>): Promise<PaginationSummary> {
  const perPage = options.perPage ?? DEFAULT_PER_PAGE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const signature = options.signature ?? defaultSignature;

  let pages = 0;
  let items = 0;
  let previousSignature: string | null = null;

  for (let page = 1; page <= maxPages; page++) {
    if (options.shouldAbort && (await options.shouldAbort())) {
      return { pages, items, stopReason: "ABORTED", completed: true };
    }

    const result = await fetchPage(page, perPage);
    const batch = result.items ?? [];

    if (batch.length === 0) {
      // 空ページは正常な終わり方。総件数が perPage の倍数のとき、
      // 最後の満杯ページの次に空ページが来る。
      return { pages, items, stopReason: "EMPTY_PAGE", completed: true };
    }

    const sig = signature(batch);
    if (previousSignature !== null && sig === previousSignature) {
      // ページ番号を進めたのに同じ内容が返っている。このまま続けると
      // 同じデータを無限に処理し続けるので、異常として止める。
      return { pages, items, stopReason: "DUPLICATE_PAGE", completed: false };
    }
    previousSignature = sig;

    await options.onPage(batch, page);
    pages += 1;
    items += batch.length;

    if (!result.hasMore) {
      return { pages, items, stopReason: "LAST_PAGE", completed: true };
    }
  }

  // ここへ来るのは異常。件数上限として黙って打ち切ったのではないことを
  // 呼び出し側が区別できるよう completed:false で返す。
  return { pages, items, stopReason: "PAGE_LIMIT", completed: false };
}

/** 失敗時に利用者へ見せる説明。内部値やSecretは含めない。 */
export function describeStopReason(summary: PaginationSummary): string {
  switch (summary.stopReason) {
    case "LAST_PAGE":
    case "EMPTY_PAGE":
      return `最終ページまで取得しました（${summary.pages}ページ / ${summary.items}件）。`;
    case "ABORTED":
      return `中断しました（${summary.pages}ページ / ${summary.items}件まで処理済み）。`;
    case "DUPLICATE_PAGE":
      return `同じページが繰り返し返されたため中断しました（${summary.pages}ページ目）。ZAICO側の応答が異常な可能性があります。`;
    case "PAGE_LIMIT":
      return `安全装置のページ上限に達したため中断しました（${summary.pages}ページ / ${summary.items}件）。件数の上限ではなく、応答が終わらない場合の保護です。`;
  }
}
