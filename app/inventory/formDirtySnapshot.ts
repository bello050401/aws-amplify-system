import type { ImageEditorSlot } from "./ImageEditor";

/**
 * Shared "did the form's actual content change" comparison for
 * NewInventoryForm/EditInventoryForm — one definition so the two forms'
 * dirty logic can't quietly drift apart (spec J: dirty = 初期値 ≠ 現在
 *値, covering text/number/date/select/checkbox/custom fields/画像 all
 * uniformly).
 *
 * A plain JSON.stringify of the whole form-state object at snapshot time
 * — simple on purpose (spec N: 過剰設計にはしないこと); every field this
 * app's forms hold is already JSON-safe (strings, numbers, plain
 * Record<string,string>). Not `useMemo`d anywhere — called on every
 * render from the owning form, which is cheap at this object's size.
 */
export interface FormDirtySnapshotInput {
  name: string;
  categoryId: string;
  statusId: string;
  locationId: string;
  quantity: string;
  unit: string;
  purchasePrice: string;
  salePrice: string;
  barcode: string;
  note: string;
  customFieldValues: Record<string, string>;
  extendedValues: Record<string, string>;
  normalImageSlots: ImageEditorSlot[];
  damageImageSlots: ImageEditorSlot[];
}

/**
 * Image slots carry several fields that are pure client-side bookkeeping
 * — `id` (a fresh crypto.randomUUID() every time a slot list is built,
 * even from identical underlying data), `localPreviewUrl` (a per-file
 * blob: URL), `uploading`/`error` (transient upload-in-progress state).
 * None of those represent "the set of images this record actually has",
 * so comparing raw slot objects would flag a record dirty just because
 * its slot list was rebuilt with fresh ids — this projects each slot
 * down to the parts that actually mean something to a viewer/consumer of
 * the saved record: which S3 object (or, for a still-uploading "new"
 * slot, `null` until the upload resolves — itself correctly dirty the
 * instant a file is picked, per spec L), and whether it's the top image.
 * Order matters (it's `sortOrder` once saved), so this is a plain array,
 * not a set.
 */
function imageSlotsSignature(slots: ImageEditorSlot[]): unknown[] {
  return slots.map((slot) => {
    if (slot.kind === "new") return { kind: "new", key: slot.storageKey, isPrimary: slot.isPrimary };
    if (slot.kind === "existing") return { kind: "existing", key: slot.storageKey, isPrimary: slot.isPrimary };
    return { kind: "copy", key: slot.sourceStorageKey, isPrimary: slot.isPrimary };
  });
}

export function buildFormDirtySnapshot(input: FormDirtySnapshotInput): string {
  return JSON.stringify({
    name: input.name,
    categoryId: input.categoryId,
    statusId: input.statusId,
    locationId: input.locationId,
    quantity: input.quantity,
    unit: input.unit,
    purchasePrice: input.purchasePrice,
    salePrice: input.salePrice,
    barcode: input.barcode,
    note: input.note,
    customFieldValues: input.customFieldValues,
    extendedValues: input.extendedValues,
    normalImages: imageSlotsSignature(input.normalImageSlots),
    damageImages: imageSlotsSignature(input.damageImageSlots),
  });
}

/**
 * Best-effort cleanup for "保存せず移動" (spec L): removes the S3 object
 * for every "new"-kind slot that already finished uploading (has a
 * `storageKey`) across both image lists. Not awaited by the caller — a
 * failed cleanup here is a minor orphaned-object concern, never worth
 * blocking or failing the navigation the user already chose to take (same
 * reasoning as every other best-effort S3 cleanup in this app — see
 * lib/inventory/imageServerOps.ts's removeInventoryImage).
 */
export function discardUnsavedNewImages(
  slots: ImageEditorSlot[],
  // Typed as "whatever is .catch()-able", not Promise<unknown> — aws-amplify/
  // storage's `remove()` returns a RemoveOperation wrapper (cancelable,
  // like uploadData's), not a plain Promise, so this only needs the one
  // method actually used here rather than the full Promise interface.
  remove: (path: string) => { catch: (onRejected: (reason: unknown) => void) => unknown },
): void {
  for (const slot of slots) {
    if (slot.kind === "new" && slot.storageKey) {
      remove(slot.storageKey).catch(() => {});
    }
  }
}
