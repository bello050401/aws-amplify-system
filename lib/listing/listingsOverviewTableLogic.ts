/**
 * EC一覧P1 レビュー補正(2026-09-13): ListingsOverviewTable.tsx(Client
 * Component、useStateを持つ)から、ページング・読み込み状態遷移・
 * 一括操作対象の算出という「値を返すだけ」のロジックを切り出した純粋
 * 関数群。React/hooksに一切依存しない — lib/inventory/historyDisplay.ts
 * と同じ考え方(依存ゼロの表示/計算ヘルパーは実行時importを持たない
 * 設計にしておくと、hooksを呼び出せないNode単体実行環境からも本物の
 * モジュールをそのままimportして検証できる。scripts/verify-listings-
 * overview-boundary.tsが実際にこのファイルを実行して検証する)。
 *
 * ## なぜページングが要るか
 *
 * 対象約348〜364件(listEcEligibleInventoryの実測、対象外カテゴリ除外
 * 後)を、検索・状態絞り込みは全件に対して行う(この画面の想定規模では
 * サーバー側ページングは過剰設計 — service.tsのlistListingsOverview
 * コメント参照)。しかし「全件に対して絞り込む」ことと「絞り込んだ
 * 結果を全部DOMに描画する」ことは別の話 — 364件の<tr>を一度に描画する
 * と、各行のInventoryThumbnail(IntersectionObserver+lazy画像解決)や
 * チェックボックスのハンドラ登録が重なり、初回描画が長くなる
 * (実ブラウザでの「フリーズ」報告の実体)。検索・絞り込み・選択は
 * 全件(filtered)に対して行いつつ、実際にDOMへ描画するのは
 * `paginate`で切り出した1ページぶんだけにする。
 */
// `import type`はTypeScriptのstrip-only modeで完全に消える(実行時の
// importにならない)——このファイルの「依存ゼロ」(冒頭コメント参照、
// scripts/verify-listings-overview-table-logic.tsがhooks非対応の素の
// Node実行環境からそのままimportできる設計)を壊さない。
import type { ListingsOverviewFailureInfo, ListingsOverviewLoadOutcome } from "./overviewFailure";

/** 1ページに描画する最大行数。364件なら4ページ程度に収まる。 */
export const LISTINGS_OVERVIEW_PAGE_SIZE = 100;

export interface PageWindow<T> {
  /** 現在ページに描画すべき行(この配列だけをテーブルへ渡す)。 */
  pageRows: T[];
  /** 実際に使われたページ番号(0始まり) — 要求値が範囲外ならクランプ済み。 */
  page: number;
  /** 総ページ数(0件のときも最低1)。 */
  pageCount: number;
  /** ページング前の総件数(絞り込み後・描画前)。 */
  totalCount: number;
}

/**
 * 0始まりのページ番号を、実際に存在する範囲へ丸める。
 *
 * 検索・絞り込みで対象件数が減った直後、古いページ番号(絞り込み前に
 * 見ていたページ)がそのまま残っていると「該当する商品がありません」
 * のような空ページを描画してしまう — 検索するたびに件数が変わるこの
 * 画面では起きやすい実害なので、常に有効な範囲へ丸める。
 */
export function clampPage(requestedPage: number, pageCount: number): number {
  if (!Number.isFinite(requestedPage) || requestedPage < 0) return 0;
  const maxPage = Math.max(0, pageCount - 1);
  return Math.min(requestedPage, maxPage);
}

/** `items`(絞り込み済みの全件)から、指定ページぶんだけを切り出す。 */
export function paginate<T>(items: readonly T[], requestedPage: number, pageSize: number): PageWindow<T> {
  const totalCount = items.length;
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  const page = clampPage(requestedPage, pageCount);
  const start = page * pageSize;
  return { pageRows: items.slice(start, start + pageSize), page, pageCount, totalCount };
}

/**
 * 一括操作(下書き一括作成)の対象になり得るIDを、絞り込み後の全件
 * (ページ内だけではない)から算出する。
 *
 * ★要件(BELLO統合改修 master指示書 §15/§16、レビュー補正§4「一括操作
 * 対象の意図せぬ拡大縮小を防ぐ」): 「すべて選択」はページを跨いだ
 * 絞り込み結果全体を対象にする — ページングを導入したことで対象範囲が
 * 「今見えている1ページぶんだけ」に縮んだり、逆に絞り込みを外れた行が
 * 紛れ込んで広がったりしない。既に下書きがある行(hasDraft)は対象外
 * (saveListingDraftのupsert仕様上、一括実行するとタイトル/価格が
 * 初期値へ巻き戻ってしまうため — service.tsのbulkCreateListingDrafts
 * コメント参照)。
 */
export function selectableInventoryIds(filteredRows: readonly { inventoryId: string; hasDraft: boolean }[]): string[] {
  return filteredRows.filter((r) => !r.hasDraft).map((r) => r.inventoryId);
}

/**
 * Mercari Shops CSV出力(2026-09-14、P2)の「すべて選択」対象。
 *
 * 上のselectableInventoryIds(下書き一括作成向け、hasDraftが無い行のみ)
 * とは対になる逆の条件——CSV出力(lib/listing/mercari/csv/buildExportRows.ts)
 * は保存済みの出品下書きを土台にするため、下書きが無い行はサーバー側で
 * 必ず「EC出品下書きが未作成です」としてブロックされる。ここで先に
 * 対象外にしておくことで、確実に失敗する行を選ばせない
 * (押した瞬間に理由が分かる方が、生成が全ブロックされてから知るより早い)。
 * 売却済み/削除済み/カテゴリ未確定等、下書きがあっても弾かれうる理由は
 * クライアント側からは分からないため、それらはサーバー側の
 * blockedRowsで初めて分かる(黙って除外はしない)。
 */
export function csvExportEligibleInventoryIds(filteredRows: readonly { inventoryId: string; hasDraft: boolean }[]): string[] {
  return filteredRows.filter((r) => r.hasDraft).map((r) => r.inventoryId);
}

/**
 * ListingsOverviewTable.tsxの読み込み状態。InventoryHistorySection.tsxの
 * LoadStateと同じ3値設計——ただし"error"はEC一覧P1 実失敗分類
 * (2026-09-13)で安全な分類情報(`failure`)を持つ。認証切れなら再ログイン
 * の案内、その他は局所再試行、という振る舞いの出し分けをこの`failure`
 * だけを見て行う(呼び出し側は元の例外・メッセージ原文には一切触れない)。
 */
export type ListingsLoadState<T> = { kind: "ok"; rows: T[] } | { kind: "error"; failure: ListingsOverviewFailureInfo } | { kind: "retrying" };

/**
 * ListingsOverviewData.tsx(async Server Component)から渡された
 * `initialResult`(lib/listing/service.tsのlistListingsOverviewSafeが
 * 返す、取得成功(行の配列)か失敗(安全な分類情報)かの判別可能な形)を、
 * useStateの初期値へ変換する。
 *
 * ★要件: 「データなし」と「取得失敗」を混同しない — 実0件
 * (`{ok:true, rows:[]}`)は`{kind:"ok", rows:[]}`として通常のテーブル
 * (0件表示)へ、取得失敗(`{ok:false, failure}`)は`{kind:"error", failure}`
 * として一括操作を無効化したエラー表示へ、それぞれ振り分ける。
 */
export function loadStateFromInitialRows<T>(initialResult: ListingsOverviewLoadOutcome<T>): ListingsLoadState<T> {
  return initialResult.ok ? { kind: "ok", rows: initialResult.rows } : { kind: "error", failure: initialResult.failure };
}
