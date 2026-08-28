"use client";

import { uploadData, remove } from "aws-amplify/storage";
import { ConfigureAmplifyClientSide } from "@/lib/amplify/configureClient";
import { InventoryThumbnail } from "./InventoryThumbnail";

/**
 * Shared image editor for both new-registration and edit (spec: editing
 * must expose the same image operations as registration — preview / add /
 * delete / reorder / set-main). Three kinds of slot, because "edit" and
 * "duplicate" each need a different relationship to an already-uploaded
 * S3 object:
 *
 * - "new": a file picked in this session. Uploads immediately (as before)
 *   so a slow/failed upload is visible right away, not at submit time.
 * - "existing": an image already on this Inventory record (edit only).
 *   Its `storageKey` is unchanged unless the user removes it — nothing
 *   is re-uploaded or copied for one that's just left alone.
 * - "copy": an image borrowed from ANOTHER Inventory record (duplicate
 *   only). Deliberately NOT the same storageKey as the source — spec
 *   explicitly rules out two records sharing one S3 object (deleting one
 *   would break the other). The actual S3 copy happens server-side, in
 *   createInventory, only once the user confirms the registration — not
 *   when the duplicate form opens — so abandoning that form never leaves
 *   an orphaned copy behind.
 *
 * The component owns upload/remove/reorder logic; the parent form just
 * holds the slot list in its own state (via onChange) so it can compute
 * anyUploading/anyError for its own submit gating, and build the final
 * per-kind payload for its Server Action at submit time.
 */
export type ImageEditorSlot =
  | { id: string; kind: "new"; localPreviewUrl: string; storageKey: string | null; uploading: boolean; error: string | null }
  | { id: string; kind: "existing"; storageKey: string }
  | { id: string; kind: "copy"; sourceStorageKey: string };

export function createNewImageSlot(file: File): ImageEditorSlot {
  return {
    id: crypto.randomUUID(),
    kind: "new",
    localPreviewUrl: URL.createObjectURL(file),
    storageKey: null,
    uploading: true,
    error: null,
  };
}

export function slotPreviewKey(slot: ImageEditorSlot): string | null {
  if (slot.kind === "existing") return slot.storageKey;
  if (slot.kind === "copy") return slot.sourceStorageKey;
  return null; // "new" uses localPreviewUrl instead
}

interface ImageEditorProps {
  slots: ImageEditorSlot[];
  onChange: (slots: ImageEditorSlot[]) => void;
}

export function ImageEditor({ slots, onChange }: ImageEditorProps) {
  async function handleFilesSelected(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    const newSlots = files.map((file) => ({ file, slot: createNewImageSlot(file) }));
    onChange([...slots, ...newSlots.map((n) => n.slot)]);

    await Promise.all(
      newSlots.map(async ({ file, slot }) => {
        const path = `inventory/${crypto.randomUUID()}-${file.name}`;
        try {
          await uploadData({ path, data: file }).result;
          patchSlot(slot.id, { storageKey: path, uploading: false });
        } catch (err) {
          patchSlot(slot.id, {
            uploading: false,
            error: err instanceof Error ? err.message : "アップロードに失敗しました。",
          });
        }
      }),
    );
  }

  // Reads current slots fresh each call (via a ref-free closure over the
  // latest onChange/slots pair is not safe across the awaited upload
  // above), so this always applies the patch against the latest array
  // rather than the array captured when the upload started.
  function patchSlot(id: string, patch: Partial<Extract<ImageEditorSlot, { kind: "new" }>>) {
    onChange(slots.map((s) => (s.kind === "new" && s.id === id ? { ...s, ...patch } : s)));
  }

  function removeSlot(id: string) {
    const slot = slots.find((s) => s.id === id);
    onChange(slots.filter((s) => s.id !== id));
    if (slot?.kind === "new" && slot.storageKey) {
      // Best-effort cleanup of the just-uploaded, now-unreferenced
      // object — not awaited/blocking, same rationale as elsewhere in
      // this codebase: an orphaned S3 object is a minor cleanup concern,
      // not worth stalling the UI over.
      remove({ path: slot.storageKey }).catch(() => {});
    }
    // "existing"/"copy" slots need no immediate cleanup: nothing was
    // uploaded/copied for them yet in this session. An "existing" image
    // removed here is cleaned up server-side by updateInventory, which
    // diffs against what's actually still on the record after save.
  }

  function moveSlot(id: string, direction: -1 | 1) {
    const index = slots.findIndex((s) => s.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= slots.length) return;
    const next = [...slots];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  function setAsMain(id: string) {
    const index = slots.findIndex((s) => s.id === id);
    if (index <= 0) return;
    const next = [...slots];
    const [item] = next.splice(index, 1);
    next.unshift(item);
    onChange(next);
  }

  return (
    <div>
      <ConfigureAmplifyClientSide />
      <label className="block text-[12px] text-gray-600">画像（複数選択可・先頭が代表画像）</label>
      <input type="file" accept="image/*" multiple onChange={(e) => handleFilesSelected(e.target.files)} className="mt-1 text-[12px]" />
      {slots.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {slots.map((slot, index) => {
            const previewKey = slotPreviewKey(slot);
            return (
              <li key={slot.id} className="w-24 border border-gray-200 p-1">
                {slot.kind === "new" ? (
                  // eslint-disable-next-line @next/next/no-img-element -- local blob: object URL preview, not a remote asset next/image can optimize
                  <img src={slot.localPreviewUrl} alt="" className="h-20 w-full object-cover" />
                ) : (
                  <InventoryThumbnail storageKey={previewKey} alt="" size="large" />
                )}
                {index === 0 && <p className="mt-0.5 text-center text-[10px] font-bold text-gray-700">メイン</p>}
                {slot.kind === "new" && slot.uploading && <p className="text-center text-[10px] text-gray-400">アップロード中…</p>}
                {slot.kind === "new" && slot.error && <p className="text-center text-[10px] text-red-600">{slot.error}</p>}
                {slot.kind === "copy" && <p className="text-center text-[10px] text-gray-400">複製元から引継ぎ</p>}
                <div className="mt-1 flex justify-between text-[10px]">
                  <button type="button" onClick={() => moveSlot(slot.id, -1)} disabled={index === 0} className="disabled:text-gray-200">
                    ↑
                  </button>
                  {index !== 0 && (
                    <button type="button" onClick={() => setAsMain(slot.id)} className="text-gray-500 hover:text-gray-900">
                      メインに
                    </button>
                  )}
                  <button type="button" onClick={() => moveSlot(slot.id, 1)} disabled={index === slots.length - 1} className="disabled:text-gray-200">
                    ↓
                  </button>
                  <button type="button" onClick={() => removeSlot(slot.id)} className="text-red-500 hover:text-red-700">
                    削除
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function imageEditorHasUploading(slots: ImageEditorSlot[]): boolean {
  return slots.some((s) => s.kind === "new" && s.uploading);
}

export function imageEditorHasError(slots: ImageEditorSlot[]): boolean {
  return slots.some((s) => s.kind === "new" && s.error);
}
