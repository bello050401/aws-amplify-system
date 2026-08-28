"use server";

import { revalidatePath } from "next/cache";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import {
  createMasterEntry,
  deleteMasterEntry,
  renameMasterEntry,
  reorderMasterEntries,
  setMasterEntryActive,
  type MasterModelName,
} from "@/lib/inventory/masters";

/**
 * Every mutation here is ADMIN-only (Phase B spec: EDITOR/VIEWER get
 * read-only master lists). The schema already enforces this independently
 * — Category/Location's `.authorization()` in amplify/data/resource.ts
 * grants EDITOR/VIEWER only `.to(["read"])` — so this check is a clean
 * error message for the settings UI, not the only thing standing between
 * a non-ADMIN and a write.
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

export async function createMasterEntryAction(model: MasterModelName, name: string): Promise<void> {
  await requireAdmin();
  await createMasterEntry(model, name);
  revalidateSettings();
}

export async function renameMasterEntryAction(model: MasterModelName, id: string, name: string): Promise<void> {
  await requireAdmin();
  await renameMasterEntry(model, id, name);
  revalidateSettings();
  // A rename can affect how an existing Inventory record's detail/edit
  // page displays its category/location name (both read by id, joined to
  // the master's current name at render time) — those pages aren't
  // statically cached here, but revalidating costs nothing and keeps this
  // correct if that ever changes.
  revalidatePath("/inventory");
}

export async function setMasterEntryActiveAction(model: MasterModelName, id: string, isActive: boolean): Promise<void> {
  await requireAdmin();
  await setMasterEntryActive(model, id, isActive);
  revalidateSettings();
  revalidatePath("/inventory");
  revalidatePath("/inventory/new");
}

export async function reorderMasterEntriesAction(model: MasterModelName, orderedIds: string[]): Promise<void> {
  await requireAdmin();
  await reorderMasterEntries(model, orderedIds);
  revalidateSettings();
}

export async function deleteMasterEntryAction(model: MasterModelName, id: string): Promise<void> {
  await requireAdmin();
  await deleteMasterEntry(model, id);
  revalidateSettings();
}
