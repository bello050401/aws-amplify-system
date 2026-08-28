"use server";

import { revalidatePath } from "next/cache";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import {
  createCustomFieldDefinition,
  reorderCustomFieldDefinitions,
  setCustomFieldDefinitionActive,
  updateCustomFieldDefinition,
  type CustomFieldInput,
} from "@/lib/inventory/customFields";

/**
 * すべてADMIN限定(spec §18: CustomField定義変更はADMIN限定)。schemaの
 * CustomFieldDefinition.authorization()もEDITOR/VIEWERにはread権限し
 * か与えていないため、ここでのチェックはUI向けの分かりやすいエラー
 * メッセージであって、それだけがガードというわけではない
 * (app/actions/masters.tsのrequireAdminと同じ考え方)。
 */
async function requireAdmin(): Promise<void> {
  const role = await getInventoryRole();
  if (role !== "ADMIN") {
    throw new Error("この操作にはADMIN権限が必要です。");
  }
}

function revalidateSettings() {
  revalidatePath("/inventory/settings");
}

export async function createCustomFieldAction(input: CustomFieldInput): Promise<void> {
  await requireAdmin();
  await createCustomFieldDefinition(input);
  revalidateSettings();
  // 新規登録フォームの追加項目一覧に即反映されるように。
  revalidatePath("/inventory/new");
}

export async function updateCustomFieldAction(id: string, input: { label: string; required: boolean; options: string[] }): Promise<void> {
  await requireAdmin();
  await updateCustomFieldDefinition(id, input);
  revalidateSettings();
  revalidatePath("/inventory");
  revalidatePath("/inventory/new");
}

export async function setCustomFieldActiveAction(id: string, isActive: boolean): Promise<void> {
  await requireAdmin();
  await setCustomFieldDefinitionActive(id, isActive);
  revalidateSettings();
  revalidatePath("/inventory");
  revalidatePath("/inventory/new");
}

export async function reorderCustomFieldsAction(orderedIds: string[]): Promise<void> {
  await requireAdmin();
  await reorderCustomFieldDefinitions(orderedIds);
  revalidateSettings();
  revalidatePath("/inventory/new");
}
