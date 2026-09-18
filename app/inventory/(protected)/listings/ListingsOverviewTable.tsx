"use client";

import { formatJstDateTime } from "@/lib/inventory/formatJst";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  bulkCreateListingDraftsAction,
  exportMercariShopsCsvAction,
  listListingsOverviewSafeAction,
} from "@/app/actions/listing";
import type { ListingOverviewRow } from "@/lib/listing/service";
import type { ListingsOverviewLoadOutcome } from "@/lib/listing/overviewFailure";
import {
  LISTINGS_OVERVIEW_PAGE_SIZE,
  loadStateFromInitialRows,
  paginate,
  selectableInventoryIds,
  csvExportEligibleInventoryIds,
  type ListingsLoadState,
} from "@/lib/listing/listingsOverviewTableLogic";
import { downloadCsvFromBase64, type MercariCsvExportOutcome } from "./mercariCsvDownload";
import { InventoryThumbnail } from "../../InventoryThumbnail";

// BELLO統合業務OS指示書(2026-08-30) §14: Listing Status State Machine
// 12値 + このUI独自の"NOT_STARTED"(ChannelListing行がまだ無い商品)。
// state自体の遷移はlib/listing/service.tsだけが行う(§14「UIが直接
// 自由にstatusを変更しない」) — ここは表示のためのラベル/バッジ定義
// のみ。
type StatusFilter = "ALL" | "NOT_STARTED" | Exclude<ListingOverviewRow["channelListing"], null>["status"];

// state.kindが"ok"以外の間、rowsとして使う安定した空配列参照。
// (呼び出しのたびに新しい[]を作るとuseMemoの依存が毎回変わってしまう)
const EMPTY_ROWS: ListingOverviewRow[] = [];

/**
 * 1行の状態を、既存のListingOverviewRow(Inventory + 最大1件のChannelListing)
 * から導出する — spec §16「外部ID/状態の可視化」に対応する唯一のロジ
 * ック(このファイル内で完結、他へは波及しない)。
 */
function statusOf(row: ListingOverviewRow): Exclude<StatusFilter, "ALL"> {
  if (!row.channelListing) return row.hasDraft ? "DRAFT" : "NOT_STARTED";
  return row.channelListing.status;
}

const STATUS_LABEL: Record<StatusFilter, string> = {
  ALL: "すべて",
  NOT_STARTED: "未着手",
  NOT_PREPARED: "未準備",
  DRAFT: "下書き",
  READY: "出品準備完了",
  QUEUED: "出品待ち",
  PUBLISHING: "出品処理中",
  ACTIVE: "出品済み",
  PAUSED: "停止中",
  SOLD: "売却済み",
  ENDED: "終了",
  RELIST_PENDING: "再出品待ち",
  ERROR: "出品失敗",
  ARCHIVED: "アーカイブ済み",
};

const STATUS_BADGE_CLASS: Record<Exclude<StatusFilter, "ALL">, string> = {
  NOT_STARTED: "bg-gray-100 text-gray-500",
  NOT_PREPARED: "bg-gray-100 text-gray-500",
  DRAFT: "bg-amber-50 text-amber-700",
  READY: "bg-amber-50 text-amber-700",
  QUEUED: "bg-blue-50 text-blue-700",
  PUBLISHING: "bg-blue-50 text-blue-700",
  ACTIVE: "bg-green-50 text-green-700",
  PAUSED: "bg-gray-100 text-gray-600",
  SOLD: "bg-green-50 text-green-700",
  ENDED: "bg-gray-100 text-gray-500",
  RELIST_PENDING: "bg-blue-50 text-blue-700",
  ERROR: "bg-red-50 text-red-700",
  ARCHIVED: "bg-gray-100 text-gray-400",
};

/**
 * BELLO統合改修 master指示書(2026-08-29統合改修版) §15/§16 —
 * 一覧ベースのEC出品管理UI本体(商品中心・検索/状態絞り込み・一括操作
 * ・外部ID/状態の可視化・詳細画面への深いリンク、という"コンセプト"の
 * 実装 — UI/デザイン/コードは他社ツールから一切コピーしていない)。
 *
 * この画面が扱う母集団(Inventory全体、既存のSEARCH_MAX_SCAN_ITEMSと
 * 同じ上限)は、このアプリが一貫して採用している「全部読み込んでから
 * クライアント側で絞り込む」規模に収まるため、検索・状態フィルタは
 * サーバー往復なしでこのコンポーネント内だけで完結させている
 * (サーバー側ページングはこの規模には過剰設計 — lib/inventory/queries.ts
 * のSEARCH_MAX_SCAN_ITEMS付近のコメントと同じ判断)。
 *
 * EC一覧P1 レビュー補正(2026-09-13): 検索・絞り込み・選択(filtered/
 * selectableIds)は変わらず全件に対して行うが、実際にDOMへ描画する行は
 * lib/listing/listingsOverviewTableLogic.tsのpaginateで1ページぶんへ
 * 切り出す(364件全部を一度に<tr>化して初回描画が重くなる/固まって
 * 見える、という実害への対応)。ページを跨いだ「すべて選択」の意味
 * (selectableIds)自体はpaginate前のfilteredから算出するので変えて
 * いない — ページングの導入前後で一括操作の対象範囲は変わらない。
 *
 * `initialResult`はServer Component側(ListingsOverviewData.tsx)から渡る
 * 取得結果 — 成功なら行の配列、失敗なら安全な分類情報(EC一覧P1 実失敗
 * 分類、2026-09-13 — lib/listing/service.tsのlistListingsOverviewSafe
 * 参照。取得失敗と実0件を混同しない、
 * app/inventory/(protected)/[id]/InventoryHistorySection.tsxと同じ設計)。
 */
export function ListingsOverviewTable({ initialResult, canEdit }: { initialResult: ListingsOverviewLoadOutcome<ListingOverviewRow>; canEdit: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<ListingsLoadState<ListingOverviewRow>>(() => loadStateFromInitialRows(initialResult));

  // runBulkCreate成功後のrouter.refresh()は、page.tsx→ListingsOverviewData
  // (Server Component)を再実行して新しいinitialResultを渡し直す——
  // ページ全体は再読み込みしない(Suspense境界内だけがやり直る)ので、
  // このClient ComponentはアンマウントされずuseStateの初期値は再評価
  // されない。以前の実装(propsのrowsをそのまま使う、内部stateを
  // 持たない)ではこれが自動的に効いていたが、取得失敗/実0件を区別する
  // 内部stateを持たせたことで素朴には効かなくなる——ここでinitialResult
  // (参照)が変わるたびに反映し直すことで、bulk作成後にバッジ・下書き
  // 有無が更新される既存の挙動を保つ。
  useEffect(() => {
    setState(loadStateFromInitialRows(initialResult));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialResult]);

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  /**
   * Mercari Shops CSV出力(2026-09-14、P2、API出品撤去に伴う手動運用向け)。
   *
   * 「下書き作成」と「CSVを作成」は対象になり得る行が排他
   * (lib/listing/listingsOverviewTableLogic.tsのselectableInventoryIds/
   * csvExportEligibleInventoryIdsのコメント参照——下書きの有無で完全に
   * 分かれる)なので、チェックボックス列・「すべて選択」・実行ボタンを
   * このmodeで出し分ける。選択状態(selected)自体は共有のSetのまま
   * モード切替時にクリアする——切替前のモードでは選べていた行が、
   * 切替後のモードでは対象外(かつては見えない)のまま残るのを防ぐ。
   */
  const [mode, setMode] = useState<"draft" | "csv">("draft");
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvOutcome, setCsvOutcome] = useState<MercariCsvExportOutcome | null>(null);

  function switchMode(next: "draft" | "csv") {
    if (next === mode) return;
    setMode(next);
    setSelected(new Set());
    setCsvOutcome(null);
    setResultMessage(null);
    setErrorMessage(null);
  }

  // useMemoで包む — 依存配列内で毎レンダー新しい[]を作る実装だと
  // (state.kindがok以外の間)`rows`の参照が変わり続け、下のfilteredの
  // useMemoが実質無効化される(ESLint react-hooks/exhaustive-depsが
  // 指摘する箇所)。
  const rows = useMemo(() => (state.kind === "ok" ? state.rows : EMPTY_ROWS), [state]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter !== "ALL" && statusOf(row) !== statusFilter) return false;
      if (!q) return true;
      return row.name.toLowerCase().includes(q) || row.displayId.toLowerCase().includes(q);
    });
  }, [rows, query, statusFilter]);

  // 検索・絞り込みが変わったら1ページ目へ戻す — 古いページ番号のまま
  // だと、件数が減った直後に空のページを描画してしまう(paginate自体
  // もクランプするが、それだと「絞り込んだら見たことのない別ページの
  // 続きが出る」体感になり、直感に反する)。
  useEffect(() => {
    setPage(0);
  }, [query, statusFilter]);

  // paginateが返す`page`は要求値(state)をクランプ済みの実際の値 —
  // 絞り込みで件数が減った直後、まだuseEffectの1ページ目リセットが
  // 走っていない一瞬でも、表示・前へ/次への活性状態はこちら(クランプ
  // 済み)を使う。stateの`page`自体は次の操作までそのまま保持する
  // (paginateへ渡す「要求値」としての役割のみ)。
  const { pageRows, page: currentPage, pageCount, totalCount } = useMemo(
    () => paginate(filtered, page, LISTINGS_OVERVIEW_PAGE_SIZE),
    [filtered, page],
  );

  // 一括下書き作成・すべて選択の対象は、ページ内だけでなく絞り込み後の
  // 全件(filtered)から算出する — lib/listing/listingsOverviewTableLogic.ts
  // のselectableInventoryIdsのコメント参照(ページングの導入で対象範囲
  // が意図せず縮んだり広がったりしないため)。
  const draftSelectableIds = useMemo(() => selectableInventoryIds(filtered), [filtered]);
  const csvSelectableIds = useMemo(() => csvExportEligibleInventoryIds(filtered), [filtered]);
  const selectableIds = mode === "draft" ? draftSelectableIds : csvSelectableIds;
  const allSelectableSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  function toggleOne(inventoryId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(inventoryId)) next.delete(inventoryId);
      else next.add(inventoryId);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelectableSelected ? new Set() : new Set(selectableIds));
  }

  async function runBulkCreate() {
    if (selected.size === 0) return;
    setBusy(true);
    setResultMessage(null);
    setErrorMessage(null);
    try {
      const result = await bulkCreateListingDraftsAction(Array.from(selected));
      const parts = [`作成: ${result.created.length}件`];
      if (result.skipped.length > 0) parts.push(`スキップ（既に下書きあり）: ${result.skipped.length}件`);
      if (result.failed.length > 0) parts.push(`失敗: ${result.failed.length}件`);
      setResultMessage(parts.join(" / "));
      if (result.failed.length > 0) {
        console.error("[ListingsOverviewTable] bulk create failures:", result.failed);
      }
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "一括作成に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Mercari Shops CSV出力(2026-09-14、P2)。0件は事前にボタンを無効化
   * するので通常は起きないが、多重クリック対策としてもガードする。
   * 生成中は二重操作防止(csvBusy)、失敗しても選択(selected)はそのまま
   * 保持する(★要件「失敗は入力保持+再試行」——選び直しをさせない)。
   */
  async function runCsvExport() {
    if (selected.size === 0 || csvBusy) return;
    setCsvBusy(true);
    setCsvOutcome(null);
    try {
      const result = await exportMercariShopsCsvAction(Array.from(selected));
      setCsvOutcome(result);
      if (result.ok && result.csvBase64 && result.filename) {
        downloadCsvFromBase64(result.csvBase64, result.filename);
        // 成功時のみ選択をクリアする(生成=出品済みではないが、この回の
        // 生成対象としては完了したという区切り)。失敗時は保持したまま。
        setSelected(new Set());
      }
    } catch (err) {
      setCsvOutcome({
        ok: false,
        requestedCount: selected.size,
        outputCount: 0,
        headerSource: "fallback-reconstruction",
        headerVerified: false,
        blockedRows: [],
        encodingErrors: [err instanceof Error ? err.message : "CSV生成に失敗しました。"],
      });
    } finally {
      setCsvBusy(false);
    }
  }

  /**
   * EC一覧P1 レビュー補正: 一覧データ自体の取得に失敗した場合の再試行
   * (「0件」と「取得失敗」を混同しない・データ欠落状態で一括操作を
   * 有効にしない — 下のJSXでstate.kind==="error"の間は一括操作ボタン
   * 列自体を描画しない)。app/inventory/(protected)/[id]/
   * InventoryHistorySection.tsxのretryと同じ形。
   *
   * EC一覧P1 実失敗分類(2026-09-13): 初回描画(ListingsOverviewData.tsx)
   * と同じ`listListingsOverviewSafeAction`(例外を投げない・安全な分類
   * 情報を返す版)を使う——素朴に例外を投げる版を使うと、再試行のたびに
   * 分類情報が失われ「初回は分類できるが再試行は汎用エラーに戻る」と
   * いう非対称が生まれる。Server Action呼び出し自体が(通信断等で)
   * rejectした場合は分類できないので"unknown"扱いにする。
   */
  async function retryLoad() {
    setState({ kind: "retrying" });
    try {
      const result = await listListingsOverviewSafeAction();
      setState(loadStateFromInitialRows(result));
    } catch {
      setState({ kind: "error", failure: { stage: null, kind: "unknown" } });
    }
  }

  if (state.kind !== "ok") {
    return (
      <div>
        {state.kind === "retrying" ? (
          <p className="text-[12px] text-gray-400" aria-live="polite">
            読み込み中…
          </p>
        ) : state.failure.kind === "auth-expired" ? (
          // EC一覧P1 実失敗分類(2026-09-13): 認証切れ(セッション期限切れ
          // 等)は、同じ資格情報のまま局所再試行しても直らない見込みが高い
          // ——ボタンでの再試行ではなく、既存のログイン画面
          // (app/inventory/InventoryHeader.tsxのログアウト導線と同じ
          // "/inventory/login")への案内に差し替える。認証処理自体
          // (signOut/再認証)はここでは一切行わない——ただの案内リンク。
          <div>
            <p className="text-[12px] text-red-600" role="alert">
              認証の有効期限が切れている可能性があります。再度ログインしてください。
            </p>
            <Link
              href="/inventory/login"
              className="mt-1 inline-block border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50"
            >
              ログイン画面へ
            </Link>
          </div>
        ) : state.failure.kind === "auth-forbidden" ? (
          // 2026-09-13 補正(task_2c27a70778613453ed): "auth-expired"とは
          // 別枝——資格情報自体は有効でも対象操作の権限が無いケース
          // (AppSyncの@auth不一致等)。再ログインしても同じロールのまま
          // なので直らない——ログイン画面への案内は出さず、局所再試行と
          // 管理者への確認を促す案内にとどめる(権限変更自体はここでは
          // 一切行わない)。
          <div>
            <p className="text-[12px] text-red-600" role="alert">
              この一覧を表示する権限が確認できませんでした。管理者にご確認ください。
            </p>
            <button
              type="button"
              onClick={() => void retryLoad()}
              className="mt-1 border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50"
            >
              再試行
            </button>
          </div>
        ) : (
          <div>
            <p className="text-[12px] text-red-600" role="alert">
              EC出品一覧を読み込めませんでした。
            </p>
            <button
              type="button"
              onClick={() => void retryLoad()}
              className="mt-1 border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50"
            >
              再試行
            </button>
          </div>
        )}
        {state.kind === "error" && (
          <p className="mt-2 text-xs text-gray-500">
            診断コード: EC-{state.failure.stage ?? "unknown"}-{state.failure.kind}
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      {canEdit && (
        <div className="mb-2 flex items-center gap-1">
          {/* Mercari Shops API出品機能の撤去(2026-09-14、P1)に伴い、
              「CSVを作成」(公式Mercari Shops取込CSVをローカル生成する
              だけ、アップロード・登録は行わない)を一括操作のもう一方の
              モードとして追加した。対象になり得る行が「下書き作成」
              (下書きが無い行)とは逆(下書きがある行)なので、チェックボックス
              列自体をモードで出し分ける——同じ選択導線(Set<string>・
              「すべて選択」・ページ越え選択)は両モードで共有する。 */}
          <button
            type="button"
            onClick={() => switchMode("draft")}
            aria-pressed={mode === "draft"}
            className={`border px-2 py-1 text-[12px] ${mode === "draft" ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}
          >
            下書き作成
          </button>
          <button
            type="button"
            onClick={() => switchMode("csv")}
            aria-pressed={mode === "csv"}
            className={`border px-2 py-1 text-[12px] ${mode === "csv" ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}
          >
            CSVを作成
          </button>
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="商品名・在庫IDで絞り込み"
          className="w-64 border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
        >
          {(Object.keys(STATUS_LABEL) as StatusFilter[]).map((key) => (
            <option key={key} value={key}>
              {STATUS_LABEL[key]}
            </option>
          ))}
        </select>
        <span className="text-[12px] text-gray-500">{totalCount.toLocaleString("ja-JP")}件表示</span>

        {canEdit && (
          <div className="ml-auto flex items-center gap-2">
            {selected.size > 0 && <span className="text-[12px] text-gray-600">{selected.size}件選択中</span>}
            {mode === "draft" ? (
              <button
                type="button"
                onClick={runBulkCreate}
                disabled={busy || selected.size === 0}
                className="bg-gray-900 px-3 py-1 text-[13px] font-bold text-white disabled:opacity-50"
              >
                {busy ? "作成中…" : "選択した商品の出品下書きを一括作成"}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void runCsvExport()}
                  disabled={csvBusy || selected.size === 0}
                  className="bg-gray-900 px-3 py-1 text-[13px] font-bold text-white disabled:opacity-50"
                  title="Mercari Shops公式の商品一括登録CSV(88列)をローカルへダウンロードします。アップロード・登録は行いません。"
                >
                  {csvBusy ? "生成中…" : "CSVを作成"}
                </button>

              </>
            )}
            {/* Mercari Shops API出品機能の撤去(2026-09-14、P1)に伴い、
                EC一覧からの自動値下げルール一括割当(旧「自動値下げルールを
                設定」ボタン→/pricing-rules/assign、対象は常にMercariの
                ChannelListingのみだった)は削除した——遷移先ページ自体を
                撤去済み(app/inventory/(protected)/listings/pricing-rules/
                assign/page.tsx参照)。ルール自体の作成・一覧はチャネルに
                依存しないため、下記リンクはそのまま残す。 */}
            <Link href="/inventory/listings/pricing-rules" className="text-[12px] text-blue-700 underline">
              ルール一覧を管理
            </Link>
          </div>
        )}
      </div>

      {mode === "csv" && (
        <p className="mb-2 text-[11px] text-gray-400">
          対象: 表示中の絞り込み結果のうち、出品下書きが保存済みの商品のみ選択できます（{csvSelectableIds.length.toLocaleString("ja-JP")}件）。生成はローカルCSVのみで、Mercariへの送信・登録は行いません。
        </p>
      )}

      {resultMessage && <p className="mb-2 text-[12px] text-green-700">{resultMessage}</p>}
      {errorMessage && <p className="mb-2 text-[12px] text-red-600">{errorMessage}</p>}

      {csvOutcome && (
        <div className={`mb-2 border p-2 text-[12px] ${csvOutcome.ok ? "border-green-300 bg-green-50 text-green-800" : "border-red-300 bg-red-50 text-red-700"}`}>
          {csvOutcome.ok ? (
            <p>
              CSVを生成しました（選択{csvOutcome.requestedCount.toLocaleString("ja-JP")}件 / 出力{csvOutcome.outputCount.toLocaleString("ja-JP")}件、
              ヘッダー: {csvOutcome.headerVerified ? "原本と照合済み" : "未照合(fallback)"}）。ダウンロードが開始されない場合はポップアップブロックをご確認ください。
            </p>
          ) : (
            <div>
              <p className="font-bold">
                CSVを生成できませんでした（選択{csvOutcome.requestedCount.toLocaleString("ja-JP")}件 / 出力0件——1件でも重大エラーがあると全体を止めます）。
              </p>
              {csvOutcome.encodingErrors && csvOutcome.encodingErrors.length > 0 && (
                <ul className="mt-1 list-disc pl-4">
                  {csvOutcome.encodingErrors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
              {csvOutcome.blockedRows.length > 0 && (
                <ul className="mt-1 list-disc pl-4">
                  {csvOutcome.blockedRows.map((row) => (
                    <li key={row.inventoryId}>
                      <Link href={`/inventory/${row.inventoryId}/listing`} className="font-mono underline">
                        {row.displayId}
                      </Link>
                      : {row.reasons.join(" / ")}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      <div className="overflow-x-auto border border-gray-200">
        <table className="w-full min-w-[900px] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-left text-[11px] text-gray-500">
              {canEdit && (
                <th className="w-8 px-2 py-2">
                  {/* MasterList.tsxと同じ — チェックボックスの見た目は
                      変えず、labelで包んで当たり判定だけ32px角へ広げる。 */}
                  <label className="inline-flex min-h-8 min-w-8 cursor-pointer items-center justify-center">
                    <input
                      type="checkbox"
                      checked={allSelectableSelected}
                      onChange={toggleAll}
                      disabled={selectableIds.length === 0}
                      aria-label="すべて選択"
                    />
                  </label>
                </th>
              )}
              <th className="w-24 px-2 py-2">画像</th>
              <th className="px-2 py-2">商品名 / 在庫ID</th>
              <th className="px-2 py-2">数量</th>
              <th className="px-2 py-2">価格</th>
              <th className="px-2 py-2">状態</th>
              <th className="px-2 py-2">外部ID</th>
              <th className="px-2 py-2">最終更新</th>
            </tr>
          </thead>
          <tbody>
            {totalCount === 0 && (
              <tr>
                <td colSpan={canEdit ? 8 : 7} className="px-2 py-8 text-center text-[12px] text-gray-400">
                  該当する商品がありません。
                </td>
              </tr>
            )}
            {pageRows.map((row) => {
              const status = statusOf(row);
              const canSelect = mode === "draft" ? !row.hasDraft : row.hasDraft;
              return (
                <tr key={row.inventoryId} className="border-b border-gray-100 hover:bg-gray-50">
                  {canEdit && (
                    <td className="px-2 py-2 align-middle">
                      <input
                        type="checkbox"
                        checked={selected.has(row.inventoryId)}
                        onChange={() => toggleOne(row.inventoryId)}
                        disabled={!canSelect}
                        title={canSelect ? undefined : mode === "draft" ? "既に出品下書きがあります" : "出品下書きがまだありません（先に「下書き作成」で作成してください）"}
                      />
                    </td>
                  )}
                  <td className="px-2 py-2 align-middle">
                    <InventoryThumbnail storageKey={row.thumbnailKey} alt={row.name} size="small" />
                  </td>
                  <td className="px-2 py-2 align-middle">
                    {/* 不具合修正・ZAICO同期重複根絶指示書(2026-08-30)
                        §8: 「詳細」ボタン(旧: 末尾列のリンク)を廃止し、
                        商品タイトルをクリック可能なリンクにする——
                        Linkはネイティブに<a>を描画するのでhover/focus
                        (下線+色)・キーボード操作(Tab+Enter)・
                        aria読み上げ(タイトルがリンクテキスト)を
                        追加コード無しで満たす。既存の行操作
                        (チェックボックス/画像)とは別要素なので干渉しない。 */}
                    <Link href={`/inventory/${row.inventoryId}/listing`} className="font-bold text-gray-900 underline decoration-transparent hover:decoration-gray-400 focus:outline-none focus-visible:ring-1 focus-visible:ring-gray-900">
                      {row.name}
                    </Link>
                    <div className="font-mono text-[11px] text-gray-500">{row.displayId}</div>
                  </td>
                  <td className="px-2 py-2 align-middle">{row.quantity.toLocaleString("ja-JP")}</td>
                  <td className="px-2 py-2 align-middle">{row.price != null ? `¥${row.price.toLocaleString("ja-JP")}` : "-"}</td>
                  <td className="px-2 py-2 align-middle">
                    <span className={`inline-block px-2 py-0.5 text-[11px] font-bold ${STATUS_BADGE_CLASS[status]}`}>{STATUS_LABEL[status]}</span>
                    {status === "ERROR" && row.channelListing?.lastError && (
                      <div className="mt-1 max-w-[220px] truncate text-[11px] text-red-600" title={row.channelListing.lastError}>
                        {row.channelListing.lastError}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2 align-middle">
                    {row.channelListing?.externalListingId ? (
                      row.channelListing.listingUrl ? (
                        <a
                          href={row.channelListing.listingUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-[11px] text-blue-700 underline"
                        >
                          {row.channelListing.externalListingId}
                        </a>
                      ) : (
                        <span className="font-mono text-[11px] text-gray-700">{row.channelListing.externalListingId}</span>
                      )
                    ) : (
                      <span className="text-gray-300">-</span>
                    )}
                  </td>
                  <td className="px-2 py-2 align-middle text-[11px] text-gray-500">
                    {formatJstDateTime(row.channelListing?.updatedAt ?? row.inventoryUpdatedAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ページ移動 — 検索・絞り込み・選択は全件(filtered)が対象のまま、
          DOMに描画する行だけをここで切り替える。件数が1ページに収まる
          間(pageCount===1)は前へ/次へを常に無効表示にする(押しても
          何も起きないボタンを常時活性化しておく方が誤解を招くため)。 */}
      <div className="flex items-center justify-between border-t border-gray-200 px-1 py-1.5 text-[12px] text-gray-600">
        <span>
          {totalCount === 0
            ? "0件"
            : `${(currentPage * LISTINGS_OVERVIEW_PAGE_SIZE + 1).toLocaleString("ja-JP")}–${(currentPage * LISTINGS_OVERVIEW_PAGE_SIZE + pageRows.length).toLocaleString("ja-JP")}件 / 全${totalCount.toLocaleString("ja-JP")}件`}
        </span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setPage(Math.max(0, currentPage - 1))}
            disabled={currentPage <= 0}
            className="border border-gray-300 px-2 py-1 hover:bg-gray-50 disabled:border-gray-100 disabled:text-gray-300 disabled:hover:bg-transparent"
          >
            ← 前へ
          </button>
          <span>
            {currentPage + 1} / {pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage(Math.min(pageCount - 1, currentPage + 1))}
            disabled={currentPage >= pageCount - 1}
            className="border border-gray-300 px-2 py-1 hover:bg-gray-50 disabled:border-gray-100 disabled:text-gray-300 disabled:hover:bg-transparent"
          >
            次へ →
          </button>
        </div>
      </div>
    </div>
  );
}
