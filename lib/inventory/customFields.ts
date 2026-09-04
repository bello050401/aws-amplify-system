import "server-only";
import { invalidateMasterCache } from "./masterCache";
import { randomUUID } from "crypto";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { Schema } from "@/amplify/data/resource";
import { listAllCustomFieldDefinitions } from "./queries";

type CustomFieldType = Schema["CustomFieldType"]["type"];

/**
 * 追加項目(CustomFieldDefinition)の作成/変更/並び替え/無効化 — 夜間開
 * 発指示書 §11「追加項目を本当の追加項目機能へ」。既存のCustomFieldDefinition
 * / Inventory.customFields実装(customFieldSeed.ts / customFieldsCodec.ts)
 * を最大限再利用し、ここで初めて「ADMINが管理画面から新しい追加項目を
 * 作成できる」経路を追加する — これまではcustomFieldSeed.tsのハード
 * コードされた初期6項目のみが存在し、UIからの新規作成手段が無かった。
 *
 * 新規/編集/詳細/一覧表示設定/詳細検索/Import/Exportは、すでに
 * CustomFieldDefinition一覧を実行時に読んで動的に反映するmetadata-driven
 * 設計になっている(customFieldSeed.tsの既存コメント、
 * lib/inventory/advancedSearch.tsのbuildSearchFieldDefs、
 * lib/inventory/inventoryExport.ts/inventoryImport.tsのdynamic custom
 * field処理を参照) — このファイルはCustomFieldDefinitionそのものの
 * CRUDだけを追加する。
 */

/** 内部キー(Inventory.customFieldsの中で使うJSONのプロパティ名)はADMINに手入力させない — 衝突/JS的に安全でない文字の混入を避けるため、作成時にランダム生成し、以後変更不可にする(ラベル・必須・選択肢は変更可能)。 */
function randomFieldKey(): string {
  return `field_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export interface CustomFieldInput {
  label: string;
  fieldType: CustomFieldType;
  required: boolean;
  /** fieldType === "SELECT" のときだけ意味を持つ。 */
  options: string[];
}

export async function createCustomFieldDefinition(input: CustomFieldInput): Promise<void> {
  // 2026-09-04 性能総点検: マスタを変えたらキャッシュを必ず捨てる。
  // 書き込み関数の側に置くのは、Server Action を足した人が呼び忘れても
  // 効くようにするため(lib/inventory/masterCache.ts のコメント参照)。
  invalidateMasterCache();
  const label = input.label.trim();
  if (!label) throw new Error("項目名を入力してください。");
  const options = input.options.map((o) => o.trim()).filter(Boolean);
  if (input.fieldType === "SELECT" && options.length === 0) {
    throw new Error("選択式の項目には選択肢を1つ以上入力してください。");
  }

  const existing = await listAllCustomFieldDefinitions();
  const existingKeys = new Set(existing.map((e) => e.fieldKey));
  let fieldKey = randomFieldKey();
  while (existingKeys.has(fieldKey)) fieldKey = randomFieldKey(); // 衝突はほぼ起こらないが念のため
  const nextSortOrder = existing.length === 0 ? 0 : Math.max(...existing.map((e) => e.sortOrder)) + 1;

  const { errors } = await serverDataClient.models.CustomFieldDefinition.create(
    {
      fieldKey,
      label,
      fieldType: input.fieldType,
      required: input.required,
      sortOrder: nextSortOrder,
      options: input.fieldType === "SELECT" ? options : undefined,
      isActive: true,
    },
    inventoryAuthMode,
  );
  if (errors) {
    console.error("[createCustomFieldDefinition] create failed:", errors);
    throw new Error(`追加項目の作成に失敗しました: ${JSON.stringify(errors)}`);
  }
}

/**
 * ラベル/必須/選択肢だけを変更可能にする — `fieldKey`(内部キー)と
 * `fieldType`(データの型)は作成後は変更不可。fieldTypeを変えると既存
 * のInventory.customFieldsに保存済みの値(例えば数値として保存された
 * 文字列)の解釈が壊れるため、意図的にこのファイルでは変更手段を提供
 * しない — 型を変えたい場合は新しい項目を作成し、古い方は無効化する
 * 運用を想定する。
 */
export async function updateCustomFieldDefinition(id: string, input: { label: string; required: boolean; options: string[] }): Promise<void> {
  // 2026-09-04 性能総点検: マスタを変えたらキャッシュを必ず捨てる。
  // 書き込み関数の側に置くのは、Server Action を足した人が呼び忘れても
  // 効くようにするため(lib/inventory/masterCache.ts のコメント参照)。
  invalidateMasterCache();
  const label = input.label.trim();
  if (!label) throw new Error("項目名を入力してください。");

  const { data: existing } = await serverDataClient.models.CustomFieldDefinition.get({ id }, inventoryAuthMode);
  if (!existing) throw new Error("対象の追加項目が見つかりません。");

  const options = input.options.map((o) => o.trim()).filter(Boolean);
  if (existing.fieldType === "SELECT" && options.length === 0) {
    throw new Error("選択式の項目には選択肢を1つ以上入力してください。");
  }

  const { errors } = await serverDataClient.models.CustomFieldDefinition.update(
    {
      id,
      label,
      required: input.required,
      options: existing.fieldType === "SELECT" ? options : (existing.options ?? undefined),
    },
    inventoryAuthMode,
  );
  if (errors) {
    console.error("[updateCustomFieldDefinition] update failed:", errors);
    throw new Error(`追加項目の更新に失敗しました: ${JSON.stringify(errors)}`);
  }
}

/**
 * 「安全な削除」(spec §11) — 物理削除は提供しない。CustomFieldの値は
 * Inventory.customFieldsという1つのJSON blobの中に他の項目と一緒に入
 * っているため、Category/Locationのような「参照を数えて未使用なら物
 * 理削除」という安全策がそのままでは効かない(定義を消しても既存レコー
 * ドのJSON内に値が残り続け、その値だけが宙に浮く一方、fieldKeyを再利
 * 用する新しい項目を後で作ると過去データと混同するリスクがある)。
 * isActive:falseで無効化するだけにとどめ、既存データは一切変更しない
 * — 新規登録/編集フォーム・詳細検索からは消えるが、既に値を持つ
 * Inventoryレコードの詳細ページ・Exportからは(customFieldsに値がある
 * 限り)引き続き読み取れる。
 */
export async function setCustomFieldDefinitionActive(id: string, isActive: boolean): Promise<void> {
  // 2026-09-04 性能総点検: マスタを変えたらキャッシュを必ず捨てる。
  // 書き込み関数の側に置くのは、Server Action を足した人が呼び忘れても
  // 効くようにするため(lib/inventory/masterCache.ts のコメント参照)。
  invalidateMasterCache();
  const { errors } = await serverDataClient.models.CustomFieldDefinition.update({ id, isActive }, inventoryAuthMode);
  if (errors) {
    console.error("[setCustomFieldDefinitionActive] update failed:", errors);
    throw new Error(`更新に失敗しました: ${JSON.stringify(errors)}`);
  }
}

/** lib/inventory/masters.tsのreorderMasterEntriesと同じ形 — 完全な新しい並び順を受け取り、実際に変わった行だけ書き込む。 */
export async function reorderCustomFieldDefinitions(orderedIds: string[]): Promise<void> {
  // 2026-09-04 性能総点検: マスタを変えたらキャッシュを必ず捨てる。
  // 書き込み関数の側に置くのは、Server Action を足した人が呼び忘れても
  // 効くようにするため(lib/inventory/masterCache.ts のコメント参照)。
  invalidateMasterCache();
  const current = await listAllCustomFieldDefinitions();
  const currentById = new Map(current.map((e) => [e.id, e]));
  const updates = orderedIds
    .map((id, index) => ({ id, sortOrder: index }))
    .filter(({ id, sortOrder }) => currentById.get(id)?.sortOrder !== sortOrder);
  const results = await Promise.all(
    updates.map(({ id, sortOrder }) => serverDataClient.models.CustomFieldDefinition.update({ id, sortOrder }, inventoryAuthMode)),
  );
  const failed = results.filter((r) => r.errors);
  if (failed.length > 0) {
    console.error(`[reorderCustomFieldDefinitions] update failed for ${failed.length} item(s):`, failed);
    throw new Error("並び替えの保存に失敗しました。");
  }
}
