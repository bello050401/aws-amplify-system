"use client";

import { useState } from "react";
import { uploadData, remove } from "aws-amplify/storage";
import { ConfigureAmplifyClientSide } from "@/lib/amplify/configureClient";
import { useInventoryImageUrl } from "./useInventoryImageUrl";

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

// Deliberately never embeds the original filename in the S3 key — only
// letters/digits from its extension, everything else discarded. This
// isn't just tidiness: a key containing a space, parentheses (Windows'
// own "(1)"/"(2)" duplicate-name suffix), or non-ASCII characters
// (ordinary for a real photo's filename) works fine for a plain upload,
// but breaks S3 *copy* — see lib/inventory/imageServerOps.ts's
// copyInventoryImage for why. Keeping upload and copy on the same safe
// key scheme means nothing uploaded from here on can ever hit that.
// Sizing/layout is the only thing that changed in this pass — this
// function (and every upload/remove/reorder/setMain function below it)
// is untouched.
function safeUploadPath(file: File): string {
  const match = /\.([a-zA-Z0-9]{1,8})$/.exec(file.name);
  const ext = match ? `.${match[1].toLowerCase()}` : "";
  return `inventory/${crypto.randomUUID()}${ext}`;
}

/**
 * Renders one slot's image at whatever size/fit the caller asks for.
 * Split out from InventoryThumbnail (rather than reused) because that
 * component always crops to fill (`object-cover`) for the list table's
 * fixed-size cells, while this editor wants `object-contain` — the
 * furniture's actual proportions matter when checking condition/color,
 * spec explicitly calls for preserving aspect ratio here.
 */
function EditorImagePreview({ slot, className, alt }: { slot: ImageEditorSlot; className: string; alt: string }) {
  const { url, failed } = useInventoryImageUrl(slot.kind === "new" ? null : slotPreviewKey(slot));

  if (slot.kind === "new") {
    // eslint-disable-next-line @next/next/no-img-element -- local blob: object URL preview, not a remote asset next/image can optimize
    return <img src={slot.localPreviewUrl} alt={alt} className={className} />;
  }
  if (failed || !url) {
    return (
      <div className={`${className} flex items-center justify-center bg-gray-50 text-[10px] text-gray-400`}>
        {failed ? "No Image" : "読み込み中…"}
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- S3 URL; see InventoryThumbnail's identical note.
  return <img src={url} alt={alt} className={className} />;
}

export function ImageEditor({ slots, onChange }: ImageEditorProps) {
  const [dragOver, setDragOver] = useState(false);

  async function handleFilesSelected(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    const newSlots = files.map((file) => ({ file, slot: createNewImageSlot(file) }));
    onChange([...slots, ...newSlots.map((n) => n.slot)]);

    await Promise.all(
      newSlots.map(async ({ file, slot }) => {
        const path = safeUploadPath(file);
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

  const mainSlot = slots[0];

  return (
    <div>
      <ConfigureAmplifyClientSide />
      <label className="block text-[12px] text-gray-600">画像（複数選択可・先頭が代表画像）</label>

      {/* Add area: click to browse, or drag files in. Still a plain
          <input type="file"> underneath — drag/drop just calls the same
          handleFilesSelected with the dropped FileList. */}
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFilesSelected(e.dataTransfer.files);
        }}
        className={`mt-1 flex cursor-pointer items-center justify-center border border-dashed px-4 py-3 text-[12px] ${
          dragOver ? "border-gray-500 bg-gray-50 text-gray-700" : "border-gray-300 text-gray-500 hover:bg-gray-50"
        }`}
      >
        クリックして画像を選択、またはドラッグ＆ドロップ
        <input type="file" accept="image/*" multiple onChange={(e) => handleFilesSelected(e.target.files)} className="hidden" />
      </label>

      {slots.length > 0 && (
        <>
          {/* Main preview — ~3x the old single-size thumbnail (spec):
              width tracks the form's own layout (never wider than its
              container) and is capped at max-w-sm so it can't blow out a
              wide viewport either way; height is fixed so mixed
              portrait/landscape photos don't jump the layout around as
              the main slot changes. object-contain keeps the furniture's
              real proportions intact rather than cropping to fill. */}
          <div className="mt-3 w-full max-w-sm">
            <EditorImagePreview slot={mainSlot} alt="メイン画像" className="h-64 w-full border border-gray-200 bg-gray-50 object-contain" />
            <p className="mt-1 text-[11px] font-bold text-gray-700">メイン画像</p>
          </div>

          {/* Thumbnail strip — every slot including the main one
              (highlighted), each still a full unit with its own
              reorder/set-main/delete controls, same as before. */}
          <ul className="mt-3 flex flex-wrap gap-2">
            {slots.map((slot, index) => (
              <li key={slot.id} className={`w-32 border p-1 ${index === 0 ? "border-gray-900" : "border-gray-200"}`}>
                <EditorImagePreview slot={slot} alt="" className="h-24 w-full bg-gray-50 object-cover" />
                {index === 0 && <p className="mt-0.5 text-center text-[10px] font-bold text-gray-700">メイン</p>}
                {slot.kind === "new" && slot.uploading && <p className="text-center text-[10px] text-gray-400">アップロード中…</p>}
                {slot.kind === "new" && slot.error && <p className="text-center text-[10px] text-red-600">{slot.error}</p>}
                {slot.kind === "copy" && <p className="text-center text-[10px] text-gray-400">複製元から引継ぎ</p>}
                <div className="mt-1 flex justify-between text-[11px]">
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
            ))}
          </ul>
        </>
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
