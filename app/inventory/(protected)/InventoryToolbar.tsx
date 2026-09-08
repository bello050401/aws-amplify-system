"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { InventoryRole } from "@/lib/amplify/requireInventoryUser";
import { useUnsavedChanges } from "../UnsavedChangesProvider";
import { DirectEditControls } from "./DirectEditControls";
import { ExportMenu } from "./ExportMenu";
import { ImportWizard } from "./ImportWizard";
import { BulkImageProcessingControl } from "./BulkImageProcessingControl";

interface InventoryToolbarProps {
  role: InventoryRole;
  q?: string;
  categoryIds: string[];
  locationId?: string;
  statusId?: string;
  advancedOpen: boolean;
  /** 詳細検索の条件が実際に適用されている(=一覧が詳細検索結果を表示している)かどうか。パネルを開いているだけ(advancedOpen)とは別 — スタイルの区別と「詳細検索の結果を表示中」の案内に使う。 */
  advancedActive: boolean;
  /** searchParams.advをそのまま — パネルの開閉トグルだけでは詳細検索条件を消さないため保持しておく。 */
  advRaw?: string;
  /** 総件数の表示。Suspenseで後から差し込まれるServer Componentを受け取るためReactNode。 */
  totalLabel: React.ReactNode;
}

/**
 * List-page controls, rendered as InventoryHeader's `center` content
 * (see that component's file comment) — this component supplies three
 * visually distinct roles within that one row (統合改善指示書 §3-§5):
 * 1. ページタイトル「在庫一覧」+ 件数バッジ — a clear page-title
 *    hierarchy (larger/bolder than everything beside it), not just text
 *    sitting next to a search box.
 * 2. 商品検索 — one bordered "search tool" group (icon + input + a
 *    tight-coupled 詳細検索 toggle), not a bare unlabeled `<input>`.
 * 3. 主要操作（新規登録/直接編集/インポート/エクスポート） — kept
 *    visually separate from both of the above via spacing/a divider.
 *
 * A Client Component (rather than the plain server component this used
 * to be) because 商品検索/詳細検索/新規登録 now all need to go through
 * the shared 未保存変更ガード when 一覧直接編集 has dirty rows pending
 * (統合改善指示書 §13) — see each one's onClick/onSubmit below. When
 * nothing is dirty, 詳細検索/新規登録 (plain `<Link>`s) are functionally
 * identical to a plain Link click; guardedNavigate degrades to a plain
 * `router.push` in that case (see UnsavedChangesProvider). The 商品検索
 * form (handleSearchSubmit) always does its own `router.push` — QA-002:
 * it used to let the native GET submit through whenever nothing was
 * dirty, which reloaded the whole document (auth/assets included) on
 * every search.
 */
export function InventoryToolbar({ role, q, categoryIds, locationId, statusId, advancedOpen, advancedActive, advRaw, totalLabel }: InventoryToolbarProps) {
  const canEdit = role === "ADMIN" || role === "EDITOR";
  const { isDirty, guardedNavigate } = useUnsavedChanges();
  const [importOpen, setImportOpen] = useState(false);
  const router = useRouter();
  // QA-002: 商品検索(通常検索)専用のクライアント遷移。未保存変更が無い
  // 間、以前はnative GETのform submitをそのまま許しており、検索の
  // たびにブラウザがドキュメント全体(認証初期化・アセットを含む)を
  // 読み直していた——1件だけの結果を出すのに毎回フルリロードしていた
  // のがQA-002の実体。router.pushでのSPA遷移に統一し、他のツールバー
  // 操作(詳細検索トグル・ページング・サイドバーの絞り込み、いずれも
  // 既存のLink/guardedNavigate経由)と同じ経路に揃える。
  const [isSearchPending, startSearchTransition] = useTransition();
  // Enter連打などで同一の検索先が処理中に重ねて送られても、
  // 進行中の遷移を使い回す(重複でrouter.pushを積まない)。
  const pendingSearchHrefRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isSearchPending) pendingSearchHrefRef.current = null;
  }, [isSearchPending]);

  function buildHref(overrides: Partial<{ q: string; advanced: string }> = {}) {
    const sp = new URLSearchParams();
    const nextQ = overrides.q ?? q;
    if (nextQ) sp.set("q", nextQ);
    if (categoryIds.length > 0) sp.set("categoryIds", categoryIds.join(","));
    if (locationId) sp.set("locationId", locationId);
    if (statusId) sp.set("statusId", statusId);
    if (overrides.advanced) sp.set("advanced", overrides.advanced);
    // パネルの開閉トグル自体は検索条件を消さない — 既に適用中の詳細検索
    // 条件(adv)があればそのまま引き継ぐ。
    if (advRaw) sp.set("adv", advRaw);
    const qs = sp.toString();
    return qs ? `/inventory?${qs}` : "/inventory";
  }

  const advancedHref = buildHref({ advanced: advancedOpen ? undefined : "1" });

  function handleGuardedLinkClick(e: React.MouseEvent, href: string) {
    if (!isDirty) return; // let the plain <Link> navigate normally
    e.preventDefault();
    guardedNavigate(href);
  }

  function handleSearchSubmit(e: React.FormEvent<HTMLFormElement>) {
    // 常にnative GETを止め、client-side遷移(router.push)へ統一する
    // (QA-002)。isDirtyの有無にかかわらずここでpreventDefaultする —
    // native送信を許していたのは「未保存変更が無い間だけ」で、それが
    // 検索のたびにドキュメント全体を読み直す原因だった。
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const sp = new URLSearchParams();
    for (const [key, value] of fd.entries()) {
      if (typeof value === "string" && value) sp.set(key, value);
    }
    const qs = sp.toString();
    const href = qs ? `/inventory?${qs}` : "/inventory";

    if (isDirty) {
      // 未保存の直接編集がある間は既存の3択ガードへ委ねる(保存して
      // 移動/保存せず移動/キャンセル)。guardedNavigate自身がdirtyで
      // なければrouter.pushへdegradeするが、ここでは既にisDirtyと
      // 分かっているので毎回ダイアログを経由する。
      guardedNavigate(href);
      return;
    }
    if (isSearchPending && pendingSearchHrefRef.current === href) return; // 同一検索の連打で遷移を重ねない
    pendingSearchHrefRef.current = href;
    startSearchTransition(() => {
      router.push(href);
    });
  }

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-4">
        {/* 1. ページタイトル — 「在庫一覧＋件数」を薄いborderで囲み、1つ
            のタイトル領域として認識できるようにする。カードUI(角丸・
            shadow・塗りつぶし背景)にはせず、細い罫線1本だけで区切る
            (統合改善指示書 §1: 過度なカードUIにしない)。 */}
        <div className="flex items-center gap-2 border border-gray-200 px-2.5 py-1">
          <h1 className="whitespace-nowrap text-[15px] font-bold tracking-tight text-gray-900">在庫一覧</h1>
          <span className="text-[11px] font-medium text-gray-400">{totalLabel}</span>
          {advancedActive && (
            <span className="border border-gray-900 bg-gray-900 px-1.5 py-0.5 text-[10px] font-bold text-white">詳細検索の結果</span>
          )}
        </div>

        {/* 第六ラウンド§17-18(P0-4): 装飾のみの区切り線はモバイルでは非表示にし、その分の幅を実際のコントロールに譲る。 */}
        <div className="hidden h-6 w-px bg-gray-200 md:block" aria-hidden />

        {/* 2. 商品検索 — アイコン+input+詳細検索を1つの検索ツールとして
            まとめる。検索対象・ロジックは既存のまま(name/skuのcontains)
            — 「SKU」という言葉自体をUI上に出さないだけで、SKUでの検索
            は引き続き内部的に機能する(統合改善指示書 §2)。 */}
        <div className="flex items-center gap-1.5">
          <form action="/inventory" method="get" onSubmit={handleSearchSubmit} className="flex items-center border border-gray-300 bg-white focus-within:border-gray-500 focus-within:ring-1 focus-within:ring-gray-300">
            {categoryIds.length > 0 && <input type="hidden" name="categoryIds" value={categoryIds.join(",")} />}
            {locationId && <input type="hidden" name="locationId" value={locationId} />}
            {statusId && <input type="hidden" name="statusId" value={statusId} />}
            <svg viewBox="0 0 16 16" aria-hidden className="ml-1.5 h-3.5 w-3.5 shrink-0 text-gray-400">
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                d="M11 11 L14.5 14.5 M12 7 A5 5 0 1 1 2 7 A5 5 0 0 1 12 7 Z"
              />
            </svg>
            <label className="sr-only" htmlFor="inventory-search-q">
              商品検索
            </label>
            <input
              // qが外部から変わった時(検索送信・戻る/進む・サイドバーの
              // 「すべての在庫」等、自分の入力以外での変化)だけ入力欄を
              // 作り直して表示を同期させる — defaultValueはmount時にしか
              // 効かないuncontrolled inputなので、keyを変えない限り
              // 「検索文字とURL・結果が一致しない」ままになる(QA-002の
              // 期待挙動: 戻る/進むでも整合する)。ユーザーの入力中は
              // qが変わらないのでkeyも変わらず、キー入力やIME変換を
              // 妨げない。
              key={q ?? ""}
              id="inventory-search-q"
              type="text"
              name="q"
              defaultValue={q}
              placeholder="商品を検索"
              className="w-28 border-none px-1.5 py-1 text-[13px] outline-none placeholder:text-gray-400 md:w-48"
            />
          </form>
          {/* 検索受付がすぐ分かる表示(QA-002)。router.pushの直後に同期
              でtrueになる自前のuseTransitionを使っており、Suspenseの
              loading.tsx(ツールバーごと骨格に差し替わる、もっと遅れて
              出る方のフィードバック)より先に出る。 */}
          {isSearchPending && (
            <span aria-live="polite" className="whitespace-nowrap text-[11px] font-medium text-gray-400">
              検索中…
            </span>
          )}
          <Link
            href={advancedHref}
            onClick={(e) => handleGuardedLinkClick(e, advancedHref)}
            className={`whitespace-nowrap border px-2 py-1 text-[12px] ${advancedOpen ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}
          >
            詳細検索
          </Link>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {/* 3. 主要操作 — 検索グループとは間隔で分ける。 */}
        {canEdit ? (
          <>
            <Link
              href="/inventory/new"
              onClick={(e) => handleGuardedLinkClick(e, "/inventory/new")}
              className="bg-gray-900 px-3 py-1.5 text-[13px] font-bold text-white hover:bg-gray-800"
            >
              <span className="md:hidden">+ 新規</span>
              <span className="hidden md:inline">+ 新規登録</span>
            </Link>
            <DirectEditControls />
          </>
        ) : null}
        {/* インポートはADMIN/EDITORのみ(spec §16: VIEWERは不可・ボタン
            非表示)。エクスポートは既存の閲覧権限モデルに合わせ、
            VIEWERも含め全ロールが利用可能(ExportMenu参照)。 */}
        {canEdit && (
          <button type="button" onClick={() => setImportOpen(true)} className="whitespace-nowrap border border-gray-300 px-2 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50">
            インポート
          </button>
        )}
        {/* 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §7/§12.8:
            在庫一覧のチェックボックス(InventoryTable.tsx)へ与えた実際の
            用途。選択が空の間はBulkImageProcessingControl自身が何も
            描画しない。 */}
        {canEdit && <BulkImageProcessingControl />}
        <ExportMenu
          currentFilterParams={{
            q,
            categoryIds: categoryIds.length > 0 ? categoryIds.join(",") : undefined,
            locationId,
            statusId,
            // 詳細検索の結果を表示中なら、そちらの条件でエクスポートする
            // (単純フィルタとは無関係 — バグ修正、lib/inventory/inventoryExport.ts
            // のbuildInventoryExportコメント参照)。
            adv: advancedActive ? advRaw : undefined,
          }}
        />
      </div>
      {importOpen && <ImportWizard onClose={() => setImportOpen(false)} />}
    </div>
  );
}
