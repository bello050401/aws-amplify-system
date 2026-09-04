import "server-only";
import { invalidateMasterCache } from "./masterCache";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { unwrapList } from "@/lib/amplify/listAll";

/**
 * Category / Location / Unit share an identical shape (name/sortOrder/
 * isActive — see amplify/data/resource.ts; Category/Locationはこれに
 * parentIdも持つが、このファイルの`MasterEntry`自体はparentIdを扱わな
 * い) と同一のADMIN-write/EDITOR+VIEWER-read権限を持つ。単位(Unit)は
 * 夜間開発指示書 §10で追加 — Category/Locationと違い、Inventory.unit
 * は`unitId`のような参照IDではなく従来通り自由文字列のまま(既存デー
 * タ・既存の新規登録/編集フォームの入力を一切壊さないため、Inventory
 * 側のスキーマ変更はしていない)。UnitMasterは「候補として提示する名
 * 称の一覧」であり、Inventory.unitの値そのものへの外部キーではない —
 * そのためUnitのリネームは既存Inventoryレコードのunit文字列を遡って
 * 書き換えない(countInventoryReferencesのコメント参照)。
 *
 * Note: each operation below branches explicitly on `model` and calls
 * serverDataClient.models.Category.xxx / .Location.xxx / .UnitMaster.xxx
 * directly, rather than resolving "the model client" once into a shared
 * variable — doing that turned the client into a union of structurally
 * near-identical but independently-generated generic types, and
 * TypeScript blew its comparison stack depth trying to check
 * assignability (`TS2321: Excessive stack depth`) on every call.
 * Branching per call keeps each branch's type fully concrete instead.
 */
export type MasterModelName = "Category" | "Location" | "Unit";

function masterLabel(model: MasterModelName): string {
  if (model === "Category") return "カテゴリ";
  if (model === "Location") return "保管場所";
  return "単位";
}

export interface MasterEntry {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

/**
 * Canonical comparison key for a master name — used ONLY to detect
 * duplicates/matches, never to overwrite what's actually stored or
 * displayed. Collapses the表記ゆれ (spelling variants) that produced
 * real duplicate categories in practice:
 * - `NFKC` unifies full-width/half-width forms, including turning a
 *   full-width space (U+3000) into an ordinary one.
 * - `trim()` + collapsing internal whitespace (including stray
 *   tabs/newlines pasted from elsewhere) removes padding differences.
 * - `toLowerCase()` catches any ASCII-letter casing difference.
 */
export function normalizeMasterName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Every entry regardless of isActive — the settings screen needs to show (and let ADMIN re-enable) disabled ones too, unlike listCategories()/listLocations() in queries.ts which only ever return active entries for the registration/edit forms' dropdowns. */
export async function listAllMasterEntries(model: MasterModelName): Promise<MasterEntry[]> {
  if (model === "Unit") {
    // UnitMasterは今回(夜間開発)追加したschemaで、AWS側の再デプロイ
    // (ampx sandbox / hosting build)が済むまでは実際のバックエンドに
    // まだ存在しない — その間にこのクエリを呼ぶとAppSync側が未知の型
    // としてエラーを返す。Category/Locationタブを含む設定画面全体が
    // それにつられて壊れることのないよう、Unitだけは例外を握りつぶし
    // 「まだ何も登録されていない」として空配列を返す(再デプロイ後は
    // 通常通り動く)。
    try {
      const { data } = await serverDataClient.models.UnitMaster.list(inventoryAuthMode);
      return (data ?? [])
        .map((d) => ({ id: d.id, name: d.name, sortOrder: d.sortOrder ?? 0, isActive: d.isActive ?? true }))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ja"));
    } catch (err) {
      console.warn("[listAllMasterEntries] UnitMasterの取得に失敗しました(AWS側の再デプロイが未実施の可能性があります):", err);
      return [];
    }
  }

  // この結果は seedModel の「まだ無い名前」判定に使われる。空に化けると
  // **全件をもう一度seedして重複マスタを作る**。取得の失敗は0件ではない。
  const data = unwrapList(
    model === "Category"
      ? await serverDataClient.models.Category.list(inventoryAuthMode)
      : await serverDataClient.models.Location.list(inventoryAuthMode),
    model === "Category" ? "カテゴリーマスタ" : "保管場所マスタ",
  );
  return data
    .map((d) => ({ id: d.id, name: d.name, sortOrder: d.sortOrder ?? 0, isActive: d.isActive ?? true }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ja"));
}

/**
 * New entries go to the end of the current order. Refuses a name that's
 * already present — even under a different exact spelling (full-width
 * space, trailing whitespace, casing) — via normalizeMasterName, rather
 * than only rejecting a byte-for-byte match; this is what stops today's
 * duplicate-category problem from recurring going forward (see
 * lib/inventory/masterDedupe.ts for cleaning up what's already there).
 */
export async function createMasterEntry(model: MasterModelName, name: string): Promise<void> {
  // 2026-09-04 性能総点検: マスタを変えたらキャッシュを必ず捨てる。
  // 書き込み関数の側に置くのは、Server Action を足した人が呼び忘れても
  // 効くようにするため(lib/inventory/masterCache.ts のコメント参照)。
  invalidateMasterCache();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("名称を入力してください。");
  const existing = await listAllMasterEntries(model);
  const normalized = normalizeMasterName(trimmed);
  const duplicate = existing.find((e) => normalizeMasterName(e.name) === normalized);
  if (duplicate) {
    throw new Error(`「${duplicate.name}」と同じ名称（表記ゆれ含む）が既に存在します。`);
  }
  const nextSortOrder = existing.length === 0 ? 0 : Math.max(...existing.map((e) => e.sortOrder)) + 1;
  const { errors } =
    model === "Category"
      ? await serverDataClient.models.Category.create({ name: trimmed, sortOrder: nextSortOrder, isActive: true }, inventoryAuthMode)
      : model === "Location"
        ? await serverDataClient.models.Location.create({ name: trimmed, sortOrder: nextSortOrder, isActive: true }, inventoryAuthMode)
        : await serverDataClient.models.UnitMaster.create({ name: trimmed, sortOrder: nextSortOrder, isActive: true }, inventoryAuthMode);
  if (errors) {
    console.error(`[createMasterEntry] ${model} create failed:`, errors);
    throw new Error(`追加に失敗しました: ${JSON.stringify(errors)}`);
  }
}

export async function renameMasterEntry(model: MasterModelName, id: string, name: string): Promise<void> {
  // 2026-09-04 性能総点検: マスタを変えたらキャッシュを必ず捨てる。
  // 書き込み関数の側に置くのは、Server Action を足した人が呼び忘れても
  // 効くようにするため(lib/inventory/masterCache.ts のコメント参照)。
  invalidateMasterCache();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("名称を入力してください。");
  const existing = await listAllMasterEntries(model);
  const normalized = normalizeMasterName(trimmed);
  const duplicate = existing.find((e) => e.id !== id && normalizeMasterName(e.name) === normalized);
  if (duplicate) {
    throw new Error(`「${duplicate.name}」と同じ名称（表記ゆれ含む）が既に存在します。`);
  }
  const { errors } =
    model === "Category"
      ? await serverDataClient.models.Category.update({ id, name: trimmed }, inventoryAuthMode)
      : model === "Location"
        ? await serverDataClient.models.Location.update({ id, name: trimmed }, inventoryAuthMode)
        : await serverDataClient.models.UnitMaster.update({ id, name: trimmed }, inventoryAuthMode);
  if (errors) {
    console.error(`[renameMasterEntry] ${model} update failed:`, errors);
    throw new Error(`名称の変更に失敗しました: ${JSON.stringify(errors)}`);
  }
}

export async function setMasterEntryActive(model: MasterModelName, id: string, isActive: boolean): Promise<void> {
  // 2026-09-04 性能総点検: マスタを変えたらキャッシュを必ず捨てる。
  // 書き込み関数の側に置くのは、Server Action を足した人が呼び忘れても
  // 効くようにするため(lib/inventory/masterCache.ts のコメント参照)。
  invalidateMasterCache();
  const { errors } =
    model === "Category"
      ? await serverDataClient.models.Category.update({ id, isActive }, inventoryAuthMode)
      : model === "Location"
        ? await serverDataClient.models.Location.update({ id, isActive }, inventoryAuthMode)
        : await serverDataClient.models.UnitMaster.update({ id, isActive }, inventoryAuthMode);
  if (errors) {
    console.error(`[setMasterEntryActive] ${model} update failed:`, errors);
    throw new Error(`更新に失敗しました: ${JSON.stringify(errors)}`);
  }
}

async function updateSortOrder(model: MasterModelName, id: string, sortOrder: number) {
  if (model === "Category") return serverDataClient.models.Category.update({ id, sortOrder }, inventoryAuthMode);
  if (model === "Location") return serverDataClient.models.Location.update({ id, sortOrder }, inventoryAuthMode);
  return serverDataClient.models.UnitMaster.update({ id, sortOrder }, inventoryAuthMode);
}

/** Persists a full reorder — `orderedIds` is the complete new top-to-bottom order, so sortOrder becomes each id's index. Only entries whose sortOrder actually changed are written. */
export async function reorderMasterEntries(model: MasterModelName, orderedIds: string[]): Promise<void> {
  // 2026-09-04 性能総点検: マスタを変えたらキャッシュを必ず捨てる。
  // 書き込み関数の側に置くのは、Server Action を足した人が呼び忘れても
  // 効くようにするため(lib/inventory/masterCache.ts のコメント参照)。
  invalidateMasterCache();
  const current = await listAllMasterEntries(model);
  const currentById = new Map(current.map((e) => [e.id, e]));
  const updates = orderedIds
    .map((id, index) => ({ id, sortOrder: index }))
    .filter(({ id, sortOrder }) => currentById.get(id)?.sortOrder !== sortOrder);
  const results = await Promise.all(updates.map(({ id, sortOrder }) => updateSortOrder(model, id, sortOrder)));
  const failed = results.filter((r) => r.errors);
  if (failed.length > 0) {
    console.error(`[reorderMasterEntries] ${model} update failed for ${failed.length} item(s):`, failed);
    throw new Error("並び替えの保存に失敗しました。");
  }
}

/**
 * How many Inventory records currently reference this id — the one check
 * both deleteMasterEntry and bulkDeleteMasterEntries use to decide
 * delete-vs-deactivate, kept in one place so the two can never disagree
 * about what "in use" means.
 *
 * Category/Locationは`categoryId`/`locationId`という実際の外部キーで
 * 参照されるが、Unitはそうではない — `Inventory.unit`は従来通りの自由
 * 文字列のままで(spec: 既存データ・既存フォームを壊さない設計)、
 * UnitMasterの`id`ではなく`name`と完全一致するかで「使用中」を数える。
 * これは大文字小文字/全角半角の表記ゆれを吸収しない厳密一致(DynamoDB
 * のeqそのもの)であるため、表記ゆれのある値は「未使用」に見えてしま
 * う可能性がある点に注意 — Category/Locationのような表記ゆれ吸収付き
 * の重複防止(normalizeMasterName)は今回Inventory.unit自体には及ばな
 * い。将来Inventory.unitを本当の外部キーへ移行する場合は、既存レコー
 * ドの移行方針を別途検討する必要がある(今回はそこまで踏み込まない)。
 */
/**
 * 第五ラウンド§6(P0-B) GSI/Scan監査で2点修正:
 *   1. Category/Locationはschema既存のsecondaryIndexes(HASHキーのみ、
 *      安全性はRound5 P0-Aで実測確認済み——masterDedupe.tsの同種コメント
 *      参照)を使った真のQueryに切り替える(以前は`.list({filter})`
 *      ——Inventoryテーブル全体へのScan)。
 *   2. (副次的に発見した正確性の不具合)以前はページングが無く、
 *      デフォルトpage内に収まる件数しか数えていなかった——「使用中の
 *      場合は物理削除を拒否する」という安全装置が、page境界をまたぐ
 *      場合に0件と誤判定し実際には使用中のmasterを物理削除できて
 *      しまう実害があった。categoryId/locationIdはGSI Query、unitは
 *      (indexが無いため)従来通りfilter付きScanのまま、いずれも
 *  200件単位でnextTokenを追い切ってから件数を確定する。
 */
async function countInventoryReferences(model: MasterModelName, id: string): Promise<number> {
  if (model === "Category" || model === "Location") {
    let total = 0;
    let nextToken: string | null | undefined;
    do {
      const result =
        model === "Category"
          ? await serverDataClient.models.Inventory.listInventoryByCategoryId({ categoryId: id }, { limit: 200, nextToken: nextToken ?? undefined, ...inventoryAuthMode })
          : await serverDataClient.models.Inventory.listInventoryByLocationId({ locationId: id }, { limit: 200, nextToken: nextToken ?? undefined, ...inventoryAuthMode });
      // 「使われているか」を数える処理。ここで取得に失敗して0件が
      // 返ると、deleteMasterEntry は「誰も使っていない」と判断して
      // **使用中のマスタを削除する**。失敗は0件ではない。
      total += unwrapList(result, `${masterLabel(model)}の使用件数`).length;
      nextToken = result.nextToken;
    } while (nextToken);
    return total;
  }
  const { data: unitEntry } = await serverDataClient.models.UnitMaster.get({ id }, inventoryAuthMode);
  if (!unitEntry) return 0;
  let total = 0;
  let nextToken: string | null | undefined;
  do {
    const res = await serverDataClient.models.Inventory.list({
      filter: { unit: { eq: unitEntry.name } },
      limit: 200,
      nextToken: nextToken ?? undefined,
      ...inventoryAuthMode,
    });
    const { nextToken: nt } = res;
    total += unwrapList(res, "単位の使用件数").length;
    nextToken = nt;
  } while (nextToken);
  return total;
}

/**
 * Physical delete is refused whenever any Inventory record currently
 * references this id (spec: "使用中の場合は無効化を優先" / never break
 * an existing reference) — the caller (settings UI) is expected to
 * offer 無効化 instead in that case. Checking a `deletedAt`-agnostic
 * count is deliberate: an Inventory soft-deletion in a future phase
 * would still reference this id in its history/record, so "in use"
 * here means "any Inventory row has this id", full stop.
 */
export async function deleteMasterEntry(model: MasterModelName, id: string): Promise<void> {
  // 2026-09-04 性能総点検: マスタを変えたらキャッシュを必ず捨てる。
  // 書き込み関数の側に置くのは、Server Action を足した人が呼び忘れても
  // 効くようにするため(lib/inventory/masterCache.ts のコメント参照)。
  invalidateMasterCache();
  const inUseCount = await countInventoryReferences(model, id);
  if (inUseCount > 0) {
    throw new Error(`${inUseCount}件の在庫がこの${masterLabel(model)}を使用しているため削除できません。無効化してください。`);
  }
  const { errors } =
    model === "Category"
      ? await serverDataClient.models.Category.delete({ id }, inventoryAuthMode)
      : model === "Location"
        ? await serverDataClient.models.Location.delete({ id }, inventoryAuthMode)
        : await serverDataClient.models.UnitMaster.delete({ id }, inventoryAuthMode);
  if (errors) {
    console.error(`[deleteMasterEntry] ${model} delete failed:`, errors);
    throw new Error(`削除に失敗しました: ${JSON.stringify(errors)}`);
  }
}

/**
 * Sync-oriented upsert (ZAICO category/location sync — implementation
 * instructions §8/§9): returns the id of an existing entry matching
 * `name` (by the same normalizeMasterName comparison createMasterEntry
 * uses, active or inactive), or creates a new one and returns its id.
 * Unlike createMasterEntry, an existing match is the SUCCESS path here,
 * not an error — a sync must never fail an item just because ZAICO's
 * category/place already exists in BELLO.
 */
export async function findOrCreateMasterEntryByName(model: MasterModelName, name: string): Promise<{ id: string; created: boolean }> {
  // 2026-09-04 性能総点検: マスタを変えたらキャッシュを必ず捨てる。
  // 書き込み関数の側に置くのは、Server Action を足した人が呼び忘れても
  // 効くようにするため(lib/inventory/masterCache.ts のコメント参照)。
  invalidateMasterCache();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("名称が空です。");
  const existing = await listAllMasterEntries(model);
  const normalized = normalizeMasterName(trimmed);
  const match = existing.find((e) => normalizeMasterName(e.name) === normalized);
  if (match) return { id: match.id, created: false };

  const nextSortOrder = existing.length === 0 ? 0 : Math.max(...existing.map((e) => e.sortOrder)) + 1;
  const { data, errors } =
    model === "Category"
      ? await serverDataClient.models.Category.create({ name: trimmed, sortOrder: nextSortOrder, isActive: true }, inventoryAuthMode)
      : model === "Location"
        ? await serverDataClient.models.Location.create({ name: trimmed, sortOrder: nextSortOrder, isActive: true }, inventoryAuthMode)
        : await serverDataClient.models.UnitMaster.create({ name: trimmed, sortOrder: nextSortOrder, isActive: true }, inventoryAuthMode);
  if (errors || !data) {
    console.error(`[findOrCreateMasterEntryByName] ${model} create failed:`, errors);
    throw new Error(`${masterLabel(model)}の作成に失敗しました: ${JSON.stringify(errors)}`);
  }
  return { id: data.id, created: true };
}

export interface BulkDeleteResult {
  /** ids that were unused and got physically deleted. */
  deletedIds: string[];
  /** ids that were in use, so were deactivated instead of deleted (never a hard failure — spec: 使用中カテゴリは無効化). */
  deactivatedIds: string[];
  /** ids that hit an actual error (neither deleted nor deactivated) — a real failure, not just "in use". */
  failed: { id: string; reason: string }[];
}

/**
 * Phase C.5 §1 — bulk operation for /inventory/settings' multi-select:
 * for each id, delete it if nothing references it, deactivate it
 * (never a rejection) if something does, and only land in `failed` on an
 * actual error. Reuses deleteMasterEntry/setMasterEntryActive rather
 * than re-implementing either, and countInventoryReferences rather than
 * re-deriving "is this in use". Sequential, not Promise.all — a settings
 * screen bulk action is small in practice, and processing one at a time
 * keeps each id's outcome cleanly isolated (one slow/failing id can't
 * corrupt another's result).
 *
 * Generic over `model` exactly like every other function in this file —
 * Category and Location get this mechanism for free from the same code
 * (spec §1: "保管場所についても同じ仕組みを流用可能な構造"); which of
 * the two actually exposes the bulk-select UI is a settings-screen
 * concern, not a backend one.
 */
export async function bulkDeleteMasterEntries(model: MasterModelName, ids: string[]): Promise<BulkDeleteResult> {
  // 2026-09-04 性能総点検: マスタを変えたらキャッシュを必ず捨てる。
  // 書き込み関数の側に置くのは、Server Action を足した人が呼び忘れても
  // 効くようにするため(lib/inventory/masterCache.ts のコメント参照)。
  invalidateMasterCache();
  const result: BulkDeleteResult = { deletedIds: [], deactivatedIds: [], failed: [] };
  for (const id of ids) {
    try {
      const inUseCount = await countInventoryReferences(model, id);
      if (inUseCount > 0) {
        await setMasterEntryActive(model, id, false);
        result.deactivatedIds.push(id);
      } else {
        await deleteMasterEntry(model, id);
        result.deletedIds.push(id);
      }
    } catch (err) {
      result.failed.push({ id, reason: err instanceof Error ? err.message : "不明なエラー" });
    }
  }
  return result;
}
