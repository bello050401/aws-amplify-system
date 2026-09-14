"use server";

import { revalidatePath } from "next/cache";
import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import {
  bulkCreateListingDrafts,
  getChannelListing,
  getListingDraftForInventory,
  listListingsOverview,
  listListingsOverviewSafe,
  saveChannelOverride,
  saveListingDraft,
  listOnBase,
  type ChannelOverrideInput,
  type ListingDraftInput,
  type ListingOverviewRow,
} from "@/lib/listing/service";
import type { ListingsOverviewLoadOutcome } from "@/lib/listing/overviewFailure";
import { isBaseConnected } from "@/lib/base/oauth";
import type { ChannelListingRecord, ListingDraftRecord } from "@/lib/listing/types";
import { buildExportRowForInventory, getInventoryImageDownloadUrl, listCsvImageDownloadTargets } from "@/lib/listing/mercari/csv/buildExportRows";
import { buildMercariCsvExport, MAX_EXPORT_ROWS } from "@/lib/listing/mercari/csv/exportCsv";
import { resolveInventoryImageZipPlan, MAX_ZIP_IMAGES, MAX_ZIP_PRODUCTS } from "@/lib/listing/mercari/csv/imageBundle";
import { searchBrands, searchCategories, type BrandMasterEntry, type CategoryMasterEntry } from "@/lib/listing/mercari/csv/masters";

/**
 * BELLO統合改修 master指示書 Phase D — EC出品機能のServer Action層。
 * 権限境界(spec: 「READ ONLYとの共存」): Inventory編集権限
 * (canEditInventory — ADMIN/EDITOR)と同じ境界を出品操作にも適用する
 * (spec: 「Listing: create/edit allowed」)。VIEWERは読み取りのみ
 * (getListingDraftForInventory/getChannelListing自体はここでは権限
 * チェックしていない — 呼び出し元のServer Component側で在庫詳細を
 * 読める人なら出品状況の閲覧も問題ない、既存のInventory詳細ページと
 * 同じ閲覧権限モデル)。
 *
 * このファイルはInventoryモデルへ一切書き込まない —
 * lib/listing/service.tsと同じ境界をServer Action層でも維持している
 * (実際の書き込みはservice.ts経由のみ、という一本道)。
 */
async function requireEditPermission(): Promise<string | null> {
  const role = await getInventoryRole();
  if (!canEditInventory(role)) {
    throw new Error("EC出品の作成・編集にはADMINまたはEDITOR権限が必要です。");
  }
  return getCurrentInventoryUserEmail();
}

export async function getListingDraftAction(inventoryId: string): Promise<ListingDraftRecord | null> {
  return getListingDraftForInventory(inventoryId);
}

export async function getChannelListingAction(inventoryId: string): Promise<ChannelListingRecord | null> {
  return getChannelListing(inventoryId, "MERCARI_SHOPS");
}

export async function saveListingDraftAction(inventoryId: string, input: ListingDraftInput): Promise<ListingDraftRecord> {
  const who = await requireEditPermission();
  const result = await saveListingDraft(inventoryId, input, who);
  revalidatePath(`/inventory/${inventoryId}/listing`);
  return result;
}

export async function saveChannelOverrideAction(inventoryId: string, input: ChannelOverrideInput): Promise<ChannelListingRecord> {
  const who = await requireEditPermission();
  const result = await saveChannelOverride(inventoryId, "MERCARI_SHOPS", input, who);
  revalidatePath(`/inventory/${inventoryId}/listing`);
  return result;
}

// Mercari Shops API出品機能の撤去(2026-09-14、P1)。旧`listOnMercariAction`
// (Mercariへ実際に出品するServer Action)はここにあった。呼び出し元
// (ListingForm.tsxの「Mercariに出品する」ボタン)も削除済み——外部通信に
// 到達する経路自体が無くなっている(復活の余地を残さないため、環境変数
// 等で再有効化できる形の無効化ではなく、関数ごと削除した)。

// BELLO統合業務OS 第二次完全完遂指示(2026-08-30) §4: BASEチャネル用の
// 対応するServer Action群 — Mercari用の上記と全く同じ権限境界。
export async function getBaseChannelListingAction(inventoryId: string): Promise<ChannelListingRecord | null> {
  return getChannelListing(inventoryId, "BASE");
}

export async function saveBaseChannelOverrideAction(inventoryId: string, input: ChannelOverrideInput): Promise<ChannelListingRecord> {
  const who = await requireEditPermission();
  const result = await saveChannelOverride(inventoryId, "BASE", input, who);
  revalidatePath(`/inventory/${inventoryId}/listing`);
  return result;
}

export async function listOnBaseAction(inventoryId: string): Promise<ChannelListingRecord> {
  const who = await requireEditPermission();
  const result = await listOnBase(inventoryId, who);
  revalidatePath(`/inventory/${inventoryId}/listing`);
  return result;
}

export async function isBaseConnectedAction(): Promise<boolean> {
  return isBaseConnected();
}

/**
 * BELLO統合改修 master指示書(2026-08-29統合改修版) §15/§16: 一覧ベース
 * のEC出品管理画面(app/inventory/(protected)/listings/page.tsx)向け。
 * 閲覧はrequireEditPermissionを課さない — 在庫詳細を読める人(VIEWER
 * 含む)なら出品状況の一覧閲覧も問題ない、既存のgetListingDraftAction/
 * getChannelListingActionと同じ閲覧権限モデル。
 */
export async function listListingsOverviewAction(): Promise<ListingOverviewRow[]> {
  return listListingsOverview();
}

/**
 * EC一覧P1 実失敗分類(2026-09-13): ListingsOverviewTable.tsxの再試行
 * ボタン(retryLoad)専用。`listListingsOverviewAction`(上記、失敗したら
 * 例外を投げる版)とは別に用意する — 再試行時も初回描画(ListingsOverviewData.tsx)と同じ
 * `listListingsOverviewSafe`(安全な分類情報を返す、例外を投げない版)を
 * 通すことで、「初回は分類できるが再試行は汎用エラーに戻る」という
 * 非対称を避ける。戻り値は行の配列(成功)か固定の分類コード(失敗)の
 * どちらか——GraphQLメッセージ原文・商品名・トークンは含まない。
 */
export async function listListingsOverviewSafeAction(): Promise<ListingsOverviewLoadOutcome<ListingOverviewRow>> {
  return listListingsOverviewSafe();
}

/** 一覧画面からの一括下書き作成(spec §16: 一括操作) — 書き込みなのでcanEditInventory境界を課す。 */
export async function bulkCreateListingDraftsAction(
  inventoryIds: string[],
): Promise<{ created: string[]; skipped: string[]; failed: { inventoryId: string; error: string }[] }> {
  const who = await requireEditPermission();
  const result = await bulkCreateListingDrafts(inventoryIds, who);
  if (result.created.length > 0) revalidatePath("/inventory/listings");
  return result;
}

// Mercari Shops API出品機能の撤去(2026-09-14、P1)。旧`listMercariCategoriesAction`
// (Mercariのカテゴリー一覧をAPIから取得するServer Action、Mercari APIから
// 動的に取得していたもの)はここにあった。呼び出し元(ListingForm.tsxの
// カテゴリー選択UI)も削除済み。
//
// 下記2つ(searchMercariCategoriesAction/searchMercariBrandsAction)は
// それとは別物 — CSV出力機能(2026-09-14、P2)向けに、提供された
// マスタCSV(data/mercari-masters/、外部APIへは一切到達しない)を検索
// するだけの読み取り専用Server Action。全件を返さず結果上限つき
// (lib/listing/mercari/csv/masters.ts参照)。閲覧権限モデルは
// getChannelListingActionと同じ(書き込みではないためrequireEditPermission
// を課さない)。

export async function searchMercariCategoriesAction(query: string): Promise<CategoryMasterEntry[]> {
  return searchCategories(query);
}

export async function searchMercariBrandsAction(query: string): Promise<BrandMasterEntry[]> {
  return searchBrands(query);
}

export interface MercariCsvExportActionResult {
  ok: boolean;
  requestedCount: number;
  outputCount: number;
  headerSource: "official-file" | "fallback-reconstruction";
  headerVerified: boolean;
  blockedRows: { inventoryId: string; displayId: string; reasons: string[] }[];
  encodingErrors?: string[];
  csvBase64?: string;
  filename?: string;
}

/**
 * EC準備一覧からの「CSVを作成」入口(Mercari Shops公式取込CSV、API連携
 * 撤去に伴う手動運用向け)。読み取りのみ(Inventory/ListingDraft/
 * ChannelListingへは一切書き込まない)なので、閲覧権限モデル
 * (listListingsOverviewActionと同じ、requireEditPermissionは課さない)
 * を使う。1行でも重大エラーがあれば全体を止め、部分成功のCSVは返さない
 * (`lib/listing/mercari/csv/exportCsv.ts`参照)。
 */
export async function exportMercariShopsCsvAction(inventoryIds: string[]): Promise<MercariCsvExportActionResult> {
  if (inventoryIds.length === 0) {
    return {
      ok: false,
      requestedCount: 0,
      outputCount: 0,
      headerSource: "fallback-reconstruction",
      headerVerified: false,
      blockedRows: [],
      encodingErrors: ["対象商品が0件です。1件以上選択してください"],
    };
  }
  if (inventoryIds.length > MAX_EXPORT_ROWS) {
    return {
      ok: false,
      requestedCount: inventoryIds.length,
      outputCount: 0,
      headerSource: "fallback-reconstruction",
      headerVerified: false,
      blockedRows: [],
      encodingErrors: [`一度に生成できるのは最大${MAX_EXPORT_ROWS}商品です(選択${inventoryIds.length}件)`],
    };
  }

  const results = await Promise.all(inventoryIds.map((id) => buildExportRowForInventory(id)));
  const blocked = results.filter((r) => !r.ok) as Extract<(typeof results)[number], { ok: false }>[];
  if (blocked.length > 0) {
    return {
      ok: false,
      requestedCount: inventoryIds.length,
      outputCount: 0,
      headerSource: "fallback-reconstruction",
      headerVerified: false,
      blockedRows: blocked.map((b) => ({ inventoryId: b.inventoryId, displayId: b.displayId, reasons: b.reasons })),
    };
  }

  const rows = (results as Extract<(typeof results)[number], { ok: true }>[]).map((r) => r.fields);
  const exportResult = buildMercariCsvExport(rows);
  return {
    ok: exportResult.ok,
    requestedCount: exportResult.requestedCount,
    outputCount: exportResult.outputCount,
    headerSource: exportResult.headerSource,
    headerVerified: exportResult.headerVerified,
    blockedRows: exportResult.blockedRows,
    encodingErrors: exportResult.encodingErrors,
    csvBase64: exportResult.csv ? exportResult.csv.buffer.toString("base64") : undefined,
    filename: exportResult.csv?.filename,
  };
}

export interface MercariCsvImageDownloadLink {
  filename: string;
  /** Amplify Storageの短期署名URL(既定1時間)。恒久URLではない。 */
  url: string;
}

/**
 * 画像受渡し導線(指示書§4)の「次点」——既存BASE画像URLとの確定紐付け
 * フィールドがInventoryに無いため自動採用せず(次工程へ送る旨は
 * lib/listing/mercari/csv/buildExportRows.tsのlistCsvImageDownloadTargets
 * コメント参照)、自社S3の署名URLのみを人が手元へ落とすための入口。
 * 閲覧のみ(書き込みなし)なので他の閲覧系Actionと同じくrequireEditPermissionは課さない。
 */
export async function getMercariCsvImageDownloadLinksAction(
  inventoryId: string,
): Promise<{ ok: true; displayId: string; links: MercariCsvImageDownloadLink[] } | { ok: false; reason: string }> {
  const targets = await listCsvImageDownloadTargets(inventoryId);
  if (!targets.ok) return targets;
  const links = await Promise.all(
    targets.images.map(async (img) => ({
      filename: img.filename,
      // CSVの商品画像名列と同じファイル名でContent-Dispositionを強制する
      // (buildExportRows.tsのgetInventoryImageDownloadUrlコメント参照)。
      url: await getInventoryImageDownloadUrl(img.storageKey, img.filename),
    })),
  );
  return { ok: true, displayId: targets.displayId, links };
}

export interface MercariCsvImageZipPlanItem {
  inventoryId: string;
  displayId: string;
  filename: string;
  /** Amplify Storageの短期署名URL(既定1時間)。恒久URLではない。 */
  url: string;
}

export interface MercariCsvImageZipPlanActionResult {
  ok: boolean;
  reason?: string;
  failures?: { inventoryId: string; displayId: string; reason: string }[];
  filename?: string;
  plan?: MercariCsvImageZipPlanItem[];
}

/**
 * 画像まとめダウンロード(ZIP)の「計画」を返す(task_f712cf24a9fe2308cd、
 * 2026-09-14是正——旧`getMercariCsvImageZipAction`はここで画像バイトを
 * 読み切ってbase64化しServer Actionの戻り値として返していたが、実写真
 * 運用でAmplify Hosting Web Computeの応答上限5.72MBを超え504(コンテンツ
 * 無し)になる設計だったため撤去した。根拠・詳細設計は
 * lib/listing/mercari/csv/imageBundle.tsのコメント参照)。
 *
 * この関数はCSVと同じ`imageFilename()`(lib/listing/mercari/csv/
 * assembleRow.ts)で決まるファイル名をURLに対応付けて返すだけ——実際の
 * 画像バイト取得とZIP組み立ては呼び出し元のブラウザ側
 * (lib/listing/mercari/csv/browserImageZip.ts)が行う(S3から直接、この
 * サーバーを経由しない)。1件でも対象解決(下書き未作成・画像0枚等)に
 * 失敗したら全体を止める方針は維持する——画像バイト自体の取得失敗
 * (期限切れ・通信断等)はbrowserImageZip.ts側が同じ「部分成功を返さない」
 * 方針を引き継ぐ。読み取りのみ(書き込みなし)なので他の閲覧系Actionと
 * 同じくrequireEditPermissionは課さない——対象storageKeyは常にサーバー
 * 側でinventoryId→下書きから解決したものだけを使う(クライアントからの
 * 任意キー入力は受け付けない)。
 */
export async function getMercariCsvImageZipPlanAction(inventoryIds: string[]): Promise<MercariCsvImageZipPlanActionResult> {
  if (inventoryIds.length > MAX_ZIP_PRODUCTS) {
    return { ok: false, reason: `画像まとめダウンロードは一度に最大${MAX_ZIP_PRODUCTS}商品までです(選択${inventoryIds.length}件、上限${MAX_ZIP_IMAGES}枚)` };
  }
  const result = await resolveInventoryImageZipPlan(inventoryIds);
  if (!result.ok) {
    return { ok: false, reason: result.reason, failures: result.failures };
  }
  return {
    ok: true,
    filename: result.filename,
    plan: result.plan,
  };
}
