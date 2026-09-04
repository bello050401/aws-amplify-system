import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { unwrapList, unwrapWrite } from "@/lib/amplify/listAll";
import { logInventoryHistory } from "./history";
import { clearInventoryCountCache } from "./inventoryCountCache";
import { buildZaicoSourceLinkId } from "./zaicoSyncEngine";

/**
 * 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §11.5「全件監査」
 * §11.9「既存重複の整理」への対応。
 *
 * `lib/inventory/zaicoSyncEngine.ts`/`zaicoSyncPorts.ts`の修正
 * (ZaicoSourceLinkによるO(1)ルックアップ+DB層でのclaim)は「これから」
 * の新規重複を防ぐ根治だが、実データで既に確認された重複
 * (ZAICO在庫ID"50666071"等)は、根治とは独立に監査・整理する必要が
 * ある——この2ファイルがその役目を持つ。
 */

export interface ZaicoLinkedInventorySummary {
  id: string;
  sku: string;
  name: string;
  sourceInventoryId: string;
  createdAt: string;
  updatedAt: string;
  categoryId: string | null;
  locationId: string | null;
}

export interface ZaicoDuplicateGroup {
  sourceInventoryId: string;
  /** createdAt ASC(最古が先頭)——他に判断材料が無い場合、最も古いレコードを正規候補とするのが最も無難な既定値という判断(§11.9「どちらが正しい/古いか」)。ADMINは実行前にこの候補を確認でき、UIから別のレコードを正規として選び直すこともできる。 */
  records: ZaicoLinkedInventorySummary[];
  suggestedCanonicalId: string;
}

export interface ZaicoDuplicateAuditSummary {
  totalInventoryRecords: number;
  zaicoLinkedRecords: number;
  duplicateGroupCount: number;
  /** 全duplicateGroupのrecords合計(正規候補となる1件も含む——「このsourceInventoryIdに対して何件のBELLOレコードが存在するか」の総数)。 */
  duplicateAffectedRecordCount: number;
  groups: ZaicoDuplicateGroup[];
}

/**
 * 純粋関数(AWS非依存、scripts/verify-zaico-duplicate-audit.tsで直接
 * テストする) — sourceInventoryIdでグルーピングし、2件以上のグループ
 * だけを「重複」として返す。
 */
export function groupZaicoDuplicates(records: ZaicoLinkedInventorySummary[]): ZaicoDuplicateGroup[] {
  const bySource = new Map<string, ZaicoLinkedInventorySummary[]>();
  for (const r of records) {
    const list = bySource.get(r.sourceInventoryId);
    if (list) list.push(r);
    else bySource.set(r.sourceInventoryId, [r]);
  }
  const groups: ZaicoDuplicateGroup[] = [];
  for (const [sourceInventoryId, list] of bySource) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.id < b.id ? -1 : 1; // createdAtが同点(理論上稀)の場合の安定ソート
    });
    groups.push({ sourceInventoryId, records: sorted, suggestedCanonicalId: sorted[0].id });
  }
  // 影響件数が多い順(最も深刻なものを最初に見せる)→sourceInventoryId昇順で安定ソート
  groups.sort((a, b) => b.records.length - a.records.length || (a.sourceInventoryId < b.sourceInventoryId ? -1 : 1));
  return groups;
}

export function summarizeZaicoDuplicateAudit(totalInventoryRecords: number, zaicoLinked: ZaicoLinkedInventorySummary[]): ZaicoDuplicateAuditSummary {
  const groups = groupZaicoDuplicates(zaicoLinked);
  const duplicateAffectedRecordCount = groups.reduce((sum, g) => sum + g.records.length, 0);
  return {
    totalInventoryRecords,
    zaicoLinkedRecords: zaicoLinked.length,
    duplicateGroupCount: groups.length,
    duplicateAffectedRecordCount,
    groups,
  };
}

/**
 * 実DBへの全件監査(§11.5)。非削除の全Inventoryを1回だけ完全走査
 * (nextTokenを必ずループ——このラウンドで根治した
 * findExistingBySourceIdと同じ規約)し、ZAICO連携レコードだけを
 * 抽出してグルーピングする。ADMIN設定画面から手動実行する想定
 * (定期自動実行はしない——§11.5は「監査のみ、自動削除はしない」)。
 */
export async function runZaicoDuplicateAudit(): Promise<ZaicoDuplicateAuditSummary> {
  let totalInventoryRecords = 0;
  const zaicoLinked: ZaicoLinkedInventorySummary[] = [];
  let nextToken: string | null | undefined;
  do {
    const res = await serverDataClient.models.Inventory.list({
      filter: { deletedAt: { attributeExists: false } },
      nextToken: nextToken ?? undefined,
      limit: 200,
      ...inventoryAuthMode,
    });
    // 取得エラーを0件と取り違えない。空に化けると「重複は無い」と報告して
    // しまう（lib/amplify/listAll.ts の unwrapList のコメント参照）。
    const data = unwrapList(res, "重複監査の在庫一覧");
    const nt = res.nextToken;
    totalInventoryRecords += data.length;
    for (const item of data) {
      if (item.sourceSystem === "ZAICO" && item.sourceInventoryId) {
        zaicoLinked.push({
          id: item.id,
          sku: item.sku,
          name: item.name,
          sourceInventoryId: item.sourceInventoryId,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          categoryId: item.categoryId ?? null,
          locationId: item.locationId ?? null,
        });
      }
    }
    nextToken = nt;
  } while (nextToken);
  return summarizeZaicoDuplicateAudit(totalInventoryRecords, zaicoLinked);
}

// ─────────────────────────────────────────────────────────────────────
// §11.9 既存重複の安全な整理(統合/merge)。
// ─────────────────────────────────────────────────────────────────────

export interface ZaicoDuplicateMergeResult {
  sourceInventoryId: string;
  canonicalInventoryId: string;
  removedInventoryId: string;
  reassigned: {
    inventoryHistory: number;
    listingDraft: number;
    channelListing: number;
    processingJob: number;
    imageProcessingVersion: number;
    conversation: number;
  };
  imagesCopiedFromDuplicate: boolean;
}

// 以下、関連6モデルそれぞれについて明示的な付け替え関数を1つずつ書く
// (共有の汎用/動的型関数にしない) — このリポジトリの既存方針
// (lib/inventory/masters.tsのコメント: 「共有/動的なclientの型が
// TypeScriptの比較スタック深度を吹き飛ばした」)と同じ理由で、
// Amplify生成クライアントの各モデル固有の強い型を素直に使う。
// いずれも削除ではなく更新(参照だけ付け替える、masterDedupe.tsの
// reassignInventoryReferencesと同じ「データを失わない」方針)。

async function reassignInventoryHistory(fromId: string, toId: string): Promise<number> {
  let count = 0;
  let nextToken: string | null | undefined;
  do {
    const res = await serverDataClient.models.InventoryHistory.list({
      filter: { inventoryId: { eq: fromId } },
      nextToken: nextToken ?? undefined,
      limit: 200,
      ...inventoryAuthMode,
    });
    // 取得エラーを0件と取り違えない。空に化けると「付け替える行は無い」と
    // 判断したまま、この直後に重複レコードが物理削除され、参照が孤児になる。
    const data = unwrapList(res, "付け替え対象の在庫履歴");
    const nt = res.nextToken;
    const updates = await Promise.all(data.map((row) => serverDataClient.models.InventoryHistory.update({ id: row.id, inventoryId: toId }, inventoryAuthMode)));
    // 付け替えの失敗も同じ理由で握りつぶさない。
    for (const u of updates) unwrapWrite(u, "付け替え対象の在庫履歴の付け替え");
    count += data.length;
    nextToken = nt;
  } while (nextToken);
  return count;
}

async function reassignListingDraft(fromId: string, toId: string): Promise<number> {
  let count = 0;
  let nextToken: string | null | undefined;
  do {
    const res = await serverDataClient.models.ListingDraft.list({
      filter: { inventoryId: { eq: fromId } },
      nextToken: nextToken ?? undefined,
      limit: 200,
      ...inventoryAuthMode,
    });
    // 取得エラーを0件と取り違えない。空に化けると「付け替える行は無い」と
    // 判断したまま、この直後に重複レコードが物理削除され、参照が孤児になる。
    const data = unwrapList(res, "付け替え対象の出品下書き");
    const nt = res.nextToken;
    const updates = await Promise.all(data.map((row) => serverDataClient.models.ListingDraft.update({ id: row.id, inventoryId: toId }, inventoryAuthMode)));
    // 付け替えの失敗も同じ理由で握りつぶさない。
    for (const u of updates) unwrapWrite(u, "付け替え対象の出品下書きの付け替え");
    count += data.length;
    nextToken = nt;
  } while (nextToken);
  return count;
}

async function reassignChannelListing(fromId: string, toId: string): Promise<number> {
  let count = 0;
  let nextToken: string | null | undefined;
  do {
    const res = await serverDataClient.models.ChannelListing.list({
      filter: { inventoryId: { eq: fromId } },
      nextToken: nextToken ?? undefined,
      limit: 200,
      ...inventoryAuthMode,
    });
    // 取得エラーを0件と取り違えない。空に化けると「付け替える行は無い」と
    // 判断したまま、この直後に重複レコードが物理削除され、参照が孤児になる。
    const data = unwrapList(res, "付け替え対象のチャネル出品");
    const nt = res.nextToken;
    const updates = await Promise.all(data.map((row) => serverDataClient.models.ChannelListing.update({ id: row.id, inventoryId: toId }, inventoryAuthMode)));
    // 付け替えの失敗も同じ理由で握りつぶさない。
    for (const u of updates) unwrapWrite(u, "付け替え対象のチャネル出品の付け替え");
    count += data.length;
    nextToken = nt;
  } while (nextToken);
  return count;
}

async function reassignProcessingJob(fromId: string, toId: string): Promise<number> {
  let count = 0;
  let nextToken: string | null | undefined;
  do {
    const res = await serverDataClient.models.ProcessingJob.list({
      filter: { inventoryId: { eq: fromId } },
      nextToken: nextToken ?? undefined,
      limit: 200,
      ...inventoryAuthMode,
    });
    // 取得エラーを0件と取り違えない。空に化けると「付け替える行は無い」と
    // 判断したまま、この直後に重複レコードが物理削除され、参照が孤児になる。
    const data = unwrapList(res, "付け替え対象の画像処理ジョブ");
    const nt = res.nextToken;
    const updates = await Promise.all(data.map((row) => serverDataClient.models.ProcessingJob.update({ id: row.id, inventoryId: toId }, inventoryAuthMode)));
    // 付け替えの失敗も同じ理由で握りつぶさない。
    for (const u of updates) unwrapWrite(u, "付け替え対象の画像処理ジョブの付け替え");
    count += data.length;
    nextToken = nt;
  } while (nextToken);
  return count;
}

async function reassignImageProcessingVersion(fromId: string, toId: string): Promise<number> {
  let count = 0;
  let nextToken: string | null | undefined;
  do {
    const res = await serverDataClient.models.ImageProcessingVersion.list({
      filter: { inventoryId: { eq: fromId } },
      nextToken: nextToken ?? undefined,
      limit: 200,
      ...inventoryAuthMode,
    });
    // 取得エラーを0件と取り違えない。空に化けると「付け替える行は無い」と
    // 判断したまま、この直後に重複レコードが物理削除され、参照が孤児になる。
    const data = unwrapList(res, "付け替え対象の画像処理履歴");
    const nt = res.nextToken;
    const updates = await Promise.all(data.map((row) => serverDataClient.models.ImageProcessingVersion.update({ id: row.id, inventoryId: toId }, inventoryAuthMode)));
    // 付け替えの失敗も同じ理由で握りつぶさない。
    for (const u of updates) unwrapWrite(u, "付け替え対象の画像処理履歴の付け替え");
    count += data.length;
    nextToken = nt;
  } while (nextToken);
  return count;
}

async function reassignConversation(fromId: string, toId: string): Promise<number> {
  let count = 0;
  let nextToken: string | null | undefined;
  do {
    const res = await serverDataClient.models.Conversation.list({
      filter: { relatedInventoryId: { eq: fromId } },
      nextToken: nextToken ?? undefined,
      limit: 200,
      ...inventoryAuthMode,
    });
    // 取得エラーを0件と取り違えない。空に化けると「付け替える行は無い」と
    // 判断したまま、この直後に重複レコードが物理削除され、参照が孤児になる。
    const data = unwrapList(res, "付け替え対象の会話");
    const nt = res.nextToken;
    const updates = await Promise.all(data.map((row) => serverDataClient.models.Conversation.update({ id: row.id, relatedInventoryId: toId }, inventoryAuthMode)));
    // 付け替えの失敗も同じ理由で握りつぶさない。
    for (const u of updates) unwrapWrite(u, "付け替え対象の会話の付け替え");
    count += data.length;
    nextToken = nt;
  } while (nextToken);
  return count;
}

/**
 * 1グループ・1件の重複を統合する——ADMINが監査結果を見て、グループ
 * ごとに個別に実行する想定(「全部まとめて自動統合」ボタンは作らない、
 * §11.9「必要な承認点だけ明示する」)。
 *
 * 手順(データを一切失わない設計):
 *   1. 実行直前に監査を再取得し、指定の重複が今も実在するか再検証する
 *      (古い監査結果を信用しない)。
 *   2. 関連6テーブル(InventoryHistory/ListingDraft/ChannelListing/
 *      ProcessingJob/ImageProcessingVersion/Conversation)の参照を
 *      正規レコードへ付け替える(削除ではなく更新——関連データは1件も
 *      失われない)。
 *   3. 正規レコードに画像が1枚も無く、重複レコードには画像がある場合
 *      のみ、画像を正規レコードへコピーする(それ以外は正規レコードの
 *      既存フィールドを一切上書きしない——安全側の既定動作)。
 *   4. ZaicoSourceLinkを正規レコードのidへ向け直す(将来の同期が正しく
 *      canonicalを見つけられるようにする)。
 *   5. 正規レコードへ統合履歴を1件記録する。
 *   6. 重複レコードを物理削除する(関連データは全て正規側へ移した後
 *      なので、この時点でのdeleteはデータ損失を伴わない)。
 */
export async function mergeZaicoDuplicate(sourceInventoryId: string, canonicalInventoryId: string, who: string | null): Promise<ZaicoDuplicateMergeResult> {
  const current = await runZaicoDuplicateAudit();
  const group = current.groups.find((g) => g.sourceInventoryId === sourceInventoryId);
  if (!group) {
    throw new Error(`ZAICO在庫ID ${sourceInventoryId} は現在重複していません(既に解消済みか、指定が誤っています)。`);
  }
  const canonical = group.records.find((r) => r.id === canonicalInventoryId);
  if (!canonical) {
    throw new Error(`指定された正規レコード(${canonicalInventoryId})はこの重複グループに含まれていません。`);
  }
  const duplicates = group.records.filter((r) => r.id !== canonicalInventoryId);
  if (duplicates.length !== 1) {
    throw new Error(`このsourceInventoryIdには${duplicates.length}件の重複が残っています。安全のため一度に1件ずつ統合してください(再度監査を実行すると次の1件が案内されます)。`);
  }
  const duplicate = duplicates[0];

  const reassigned = {
    inventoryHistory: await reassignInventoryHistory(duplicate.id, canonical.id),
    listingDraft: await reassignListingDraft(duplicate.id, canonical.id),
    channelListing: await reassignChannelListing(duplicate.id, canonical.id),
    processingJob: await reassignProcessingJob(duplicate.id, canonical.id),
    imageProcessingVersion: await reassignImageProcessingVersion(duplicate.id, canonical.id),
    conversation: await reassignConversation(duplicate.id, canonical.id),
  };

  // 正規レコードに画像が1枚も無く、重複側にはある場合だけ画像を引き継ぐ
  // ——それ以外のフィールド(name/quantity/customFields等)は一切
  // 上書きしない(「どちらのデータが正しいか」を自動で決めつけない)。
  const canonicalRes = await serverDataClient.models.Inventory.get({ id: canonical.id }, inventoryAuthMode);
  const duplicateRes = await serverDataClient.models.Inventory.get({ id: duplicate.id }, inventoryAuthMode);
  const canonicalInv = canonicalRes.data;
  const duplicateInv = duplicateRes.data;
  const canonicalHasNoImages = !canonicalInv?.images || canonicalInv.images.length === 0;
  const duplicateHasImages = Boolean(duplicateInv?.images && duplicateInv.images.length > 0);
  let imagesCopiedFromDuplicate = false;
  if (canonicalHasNoImages && duplicateHasImages && duplicateInv) {
    await serverDataClient.models.Inventory.update({ id: canonical.id, images: duplicateInv.images, updatedBy: who ?? undefined }, inventoryAuthMode);
    imagesCopiedFromDuplicate = true;
  }

  // ZaicoSourceLinkをcanonicalへ向け直す(既存リンクが重複側を指したまま
  // 残らないようにする——次回同期時に再び重複を作らないための必須手順)。
  const linkId = buildZaicoSourceLinkId("ZAICO", sourceInventoryId);
  await serverDataClient.models.ZaicoSourceLink.update({ id: linkId, inventoryId: canonical.id }, inventoryAuthMode).catch(async () => {
    // リンクが無かった場合(このラウンドより前に作られた重複で、まだ
    // バックフィルされていないケース)は新規作成する。
    await serverDataClient.models.ZaicoSourceLink.create(
      { id: linkId, sourceSystem: "ZAICO", sourceInventoryId, inventoryId: canonical.id },
      inventoryAuthMode,
    );
  });

  await logInventoryHistory(canonical.id, who, [
    {
      fieldName: "ZAICO重複統合",
      oldValue: null,
      newValue: `ZAICO在庫ID ${sourceInventoryId} の重複レコード(内部ID ${duplicate.id}、SKU ${duplicate.sku})をこのレコードへ統合しました。`,
    },
  ]);

  const { errors: deleteErrors } = await serverDataClient.models.Inventory.delete({ id: duplicate.id }, inventoryAuthMode);
  if (deleteErrors) {
    throw new Error(`重複レコードの削除に失敗しました(関連データの付け替えは完了済みです): ${JSON.stringify(deleteErrors)}`);
  }
  // 在庫が1件減った。総件数のキャッシュを捨てる(PHASE 6)。
  clearInventoryCountCache();

  return {
    sourceInventoryId,
    canonicalInventoryId: canonical.id,
    removedInventoryId: duplicate.id,
    reassigned,
    imagesCopiedFromDuplicate,
  };
}
