import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { listAllPages } from "@/lib/amplify/listAll";

// 純粋なプロンプト組み立ては guidanceBlock.ts が持つ(テストから直接
// 呼べるようにするため)。ここからは再エクスポートするだけ。
export { buildGuidanceBlock } from "./guidanceBlock";

/**
 * BELLO改善指示(Human Editorial Guidance)の読み書き
 * (2026-09-02 追加仕様§4〜§10)。
 *
 * ── Style Profile と混ぜない ────────────────────────────────────
 *
 * BelloStyleProfile は「過去267件のBASE商品を機械が数えた結果」で、
 * 人が書き換えるものではない。こちらは「担当者が書いた改善要望」で、
 * 数えて出るものではない。**別のモデルに分けてある**のは、片方を更新
 * したときにもう片方が黙って消えないようにするため(追加仕様§5)。
 *
 * ── 生成時の優先順位 ────────────────────────────────────────────
 *
 *   1. Inventory等の確定事実     ← ここだけが「事実」
 *   2. 明示的なBELLO改善指示     ← このファイル
 *   3. BASE Style Profile        ← 文体の統計
 *   4. 類似BASE商品              ← 書き方の見本
 *   5. 一般的なAI表現            ← 最後の手段
 *
 * ただし **改善指示で商品の事実を改変することはできない**。
 * 事実の検査(checkFactSafety)と紹介文の寸法検査は改善指示より後段に
 * あり、指示に何が書かれていても効く。「サイズを紹介文に書け」という
 * 指示を入れても、validator が落とす。
 */

export interface GuidanceRule {
  id: string;
  instruction: string;
  enabled: boolean;
  sortOrder: number;
  version: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

type GuidanceRow = {
  id: string;
  instruction: string;
  enabled?: boolean | null;
  sortOrder?: number | null;
  version?: number | null;
  createdBy?: string | null;
  updatedBy?: string | null;
  createdAt: string;
  updatedAt: string;
};

function toRule(row: GuidanceRow): GuidanceRule {
  return {
    id: row.id,
    instruction: row.instruction,
    enabled: row.enabled ?? true,
    sortOrder: row.sortOrder ?? 0,
    version: row.version ?? 1,
    createdBy: row.createdBy ?? null,
    updatedBy: row.updatedBy ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 全件(無効なものも含む)。設定画面が一覧に使う。 */
export async function listGuidanceRules(): Promise<GuidanceRule[]> {
  const rows = await listAllPages<GuidanceRow>(
    async (nextToken) => {
      const res = await serverDataClient.models.ProductDescriptionGuidance.list({
        limit: 200,
        nextToken,
        ...inventoryAuthMode,
      });
      return { data: res.data as unknown as GuidanceRow[], nextToken: res.nextToken, errors: res.errors };
    },
    { label: "商品説明の改善指示" },
  );
  return rows
    .map(toRule)
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.createdAt < b.createdAt ? -1 : 1));
}

/** 生成が実際に使う、有効な指示だけ。 */
export async function listActiveGuidance(): Promise<GuidanceRule[]> {
  return (await listGuidanceRules()).filter((r) => r.enabled);
}

export async function createGuidanceRule(instruction: string, who: string | null): Promise<GuidanceRule> {
  const text = instruction.trim();
  if (!text) throw new Error("改善指示の内容を入力してください。");
  const existing = await listGuidanceRules();
  const nextOrder = existing.length === 0 ? 0 : Math.max(...existing.map((r) => r.sortOrder)) + 1;
  const { data, errors } = await serverDataClient.models.ProductDescriptionGuidance.create(
    { instruction: text, enabled: true, sortOrder: nextOrder, version: 1, createdBy: who ?? undefined, updatedBy: who ?? undefined },
    inventoryAuthMode,
  );
  if (errors || !data) throw new Error(errors?.[0]?.message ?? "改善指示を保存できませんでした。");
  return toRule(data as unknown as GuidanceRow);
}

export async function updateGuidanceRule(
  id: string,
  input: { instruction?: string; enabled?: boolean; sortOrder?: number },
  who: string | null,
): Promise<GuidanceRule> {
  const { data: current } = await serverDataClient.models.ProductDescriptionGuidance.get({ id }, inventoryAuthMode);
  if (!current) throw new Error("対象の改善指示が見つかりません。");
  const instruction = input.instruction?.trim();
  if (input.instruction !== undefined && !instruction) throw new Error("改善指示の内容を入力してください。");

  const { data, errors } = await serverDataClient.models.ProductDescriptionGuidance.update(
    {
      id,
      ...(instruction !== undefined ? { instruction } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      // 内容を変えたときだけ版を上げる。有効/無効の切り替えは版を変えない
      // (同じ文言のまま on/off しただけなので)。
      ...(instruction !== undefined ? { version: (current.version ?? 1) + 1 } : {}),
      updatedBy: who ?? undefined,
    },
    inventoryAuthMode,
  );
  if (errors || !data) throw new Error(errors?.[0]?.message ?? "改善指示を更新できませんでした。");
  return toRule(data as unknown as GuidanceRow);
}

// ── version 履歴 ────────────────────────────────────────────────

export interface SettingVersion {
  id: string;
  version: number;
  activatedAt: string;
  activatedBy: string | null;
  styleProfileVersion: number | null;
  guidanceSnapshot: { instruction: string; enabled: boolean }[];
  note: string | null;
  isActive: boolean;
  restoredFromVersion: number | null;
}

type VersionRow = {
  id: string;
  version: number;
  activatedAt: string;
  activatedBy?: string | null;
  styleProfileVersion?: number | null;
  guidanceSnapshotJson?: string | null;
  note?: string | null;
  isActive?: boolean | null;
  restoredFromVersion?: number | null;
};

function toVersion(row: VersionRow): SettingVersion {
  let snapshot: { instruction: string; enabled: boolean }[] = [];
  try {
    const parsed = JSON.parse(row.guidanceSnapshotJson ?? "[]");
    if (Array.isArray(parsed)) snapshot = parsed;
  } catch {
    // 壊れたJSONで画面ごと落とさない。空として扱い、履歴の行自体は見せる。
    snapshot = [];
  }
  return {
    id: row.id,
    version: row.version,
    activatedAt: row.activatedAt,
    activatedBy: row.activatedBy ?? null,
    styleProfileVersion: row.styleProfileVersion ?? null,
    guidanceSnapshot: snapshot,
    note: row.note ?? null,
    isActive: row.isActive ?? false,
    restoredFromVersion: row.restoredFromVersion ?? null,
  };
}

export async function listSettingVersions(): Promise<SettingVersion[]> {
  const rows = await listAllPages<VersionRow>(
    async (nextToken) => {
      const res = await serverDataClient.models.ProductDescriptionSettingVersion.list({
        limit: 200,
        nextToken,
        ...inventoryAuthMode,
      });
      return { data: res.data as unknown as VersionRow[], nextToken: res.nextToken, errors: res.errors };
    },
    { label: "商品説明設定の履歴" },
  );
  return rows.map(toVersion).sort((a, b) => b.version - a.version);
}

/**
 * 現在の改善指示の内容で、新しいversionを作ってACTIVEにする。
 *
 * 「保存しただけで生成挙動が変わらない」ようにするための明示操作
 * (追加仕様§8)。改善指示の追加・編集そのものは版を作らない。
 */
export async function activateCurrentSettings(params: {
  note: string | null;
  styleProfileVersion: number | null;
  restoredFromVersion?: number | null;
  who: string | null;
}): Promise<SettingVersion> {
  const [rules, versions] = await Promise.all([listGuidanceRules(), listSettingVersions()]);
  const nextVersion = versions.length === 0 ? 1 : Math.max(...versions.map((v) => v.version)) + 1;

  // 旧ACTIVEを先に落とす。「ACTIVEが2件同時にある瞬間」は作らない
  // (0件の瞬間は許容 —— 読み出し側は「未設定」として扱えるが、
  //  2件だとどちらが正か決められない)。
  for (const v of versions.filter((v) => v.isActive)) {
    await serverDataClient.models.ProductDescriptionSettingVersion.update({ id: v.id, isActive: false }, inventoryAuthMode);
  }

  const { data, errors } = await serverDataClient.models.ProductDescriptionSettingVersion.create(
    {
      version: nextVersion,
      activatedAt: new Date().toISOString(),
      activatedBy: params.who ?? undefined,
      styleProfileVersion: params.styleProfileVersion ?? undefined,
      guidanceSnapshotJson: JSON.stringify(rules.map((r) => ({ instruction: r.instruction, enabled: r.enabled }))),
      generationConfigJson: "{}",
      note: params.note ?? undefined,
      isActive: true,
      restoredFromVersion: params.restoredFromVersion ?? undefined,
    },
    inventoryAuthMode,
  );
  if (errors || !data) throw new Error(errors?.[0]?.message ?? "設定を有効化できませんでした。");
  return toVersion(data as unknown as VersionRow);
}

/**
 * 過去versionの内容へ戻す。
 *
 * **過去versionを書き換えない。** そのsnapshotの内容で改善指示を組み直し、
 * 新しいversionとしてACTIVEにする —— 履歴が枝分かれしないようにするため
 * (ナレッジ文書の復元と同じ考え方)。
 */
export async function restoreSettingVersion(versionId: string, who: string | null): Promise<SettingVersion> {
  const { data: target } = await serverDataClient.models.ProductDescriptionSettingVersion.get({ id: versionId }, inventoryAuthMode);
  if (!target) throw new Error("対象のversionが見つかりません。");
  const restored = toVersion(target as unknown as VersionRow);

  // 現在の指示をすべて無効化してから、snapshot の内容を作り直す。
  // 削除しないのは追加仕様§6の「削除より無効化」に合わせるため。
  const current = await listGuidanceRules();
  for (const r of current) {
    if (r.enabled) await updateGuidanceRule(r.id, { enabled: false }, who);
  }
  let order = 0;
  for (const s of restored.guidanceSnapshot) {
    const created = await createGuidanceRule(s.instruction, who);
    await updateGuidanceRule(created.id, { enabled: s.enabled, sortOrder: order++ }, who);
  }

  return activateCurrentSettings({
    note: `v${restored.version} の内容へ復元`,
    styleProfileVersion: restored.styleProfileVersion,
    restoredFromVersion: restored.version,
    who,
  });
}
