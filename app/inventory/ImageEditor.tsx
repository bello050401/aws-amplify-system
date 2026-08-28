"use client";

import { useRef, useState } from "react";
import { uploadData, remove } from "aws-amplify/storage";
import { ConfigureAmplifyClientSide } from "@/lib/amplify/configureClient";
import { useInventoryImageUrl } from "./useInventoryImageUrl";

/**
 * Shared image editor for both new-registration and edit (spec: editing
 * must expose the same image operations as registration — preview / add /
 * delete / reorder / set-top-image). Three kinds of slot, because "edit"
 * and "duplicate" each need a different relationship to an already-
 * uploaded S3 object:
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
 * Phase C.5: this ONE component now also backs both 商品画像(normal)
 * and 傷・汚れ写真(damage) editors — NewInventoryForm/EditInventoryForm
 * render it twice, once per `variant`, each with its own independent
 * slot list/state, rather than a second copy of this file existing per
 * spec §8 ("ImageEditorを二重コピーするのではなく...共通コンポーネント
 * にしてください"). `variant="normal"` is the only one that exposes a
 * "top image" control — a damage photo can never become the Inventory's
 * representative image, by construction (there's no button for it, and
 * the parent forms never tag a damage-variant slot's `isPrimary`).
 * `type`/whether the Inventory-level top image ends up on this photo is
 * decided entirely client-side here; the actual InventoryImageType
 * tagging happens once, when each form flattens its two independent slot
 * lists into one array for its Server Action call — see
 * NewInventoryForm/EditInventoryForm's submit handlers and
 * lib/inventory/imageTypes.ts.
 *
 * The component owns upload/remove/reorder/set-top logic; the parent
 * form just holds each slot list in its own state (via onChange) so it
 * can compute anyUploading/anyError across both lists for its own submit
 * gating.
 */
export type ImageEditorSlot =
  | { id: string; kind: "new"; localPreviewUrl: string; storageKey: string | null; uploading: boolean; error: string | null; isPrimary: boolean }
  | { id: string; kind: "existing"; storageKey: string; isPrimary: boolean }
  | { id: string; kind: "copy"; sourceStorageKey: string; isPrimary: boolean };

export function createNewImageSlot(file: File): ImageEditorSlot {
  return {
    id: crypto.randomUUID(),
    kind: "new",
    localPreviewUrl: URL.createObjectURL(file),
    storageKey: null,
    uploading: true,
    error: null,
    isPrimary: false,
  };
}

export function slotPreviewKey(slot: ImageEditorSlot): string | null {
  if (slot.kind === "existing") return slot.storageKey;
  if (slot.kind === "copy") return slot.sourceStorageKey;
  return null; // "new" uses localPreviewUrl instead
}

/** The slot this editor treats as "the big preview at top" — an explicit isPrimary wins, falling back to the first slot by position. Exported so a parent form can compute the same thing without duplicating the rule (e.g. to show a small top-image indicator elsewhere). Mirrors lib/inventory/imageTypes.ts's resolveTopImage, but over client-side slots rather than saved InventoryImageRecords. */
export function resolveTopSlot(slots: ImageEditorSlot[]): ImageEditorSlot | undefined {
  return slots.find((s) => s.isPrimary) ?? slots[0];
}

interface ImageEditorProps {
  slots: ImageEditorSlot[];
  onChange: (slots: ImageEditorSlot[]) => void;
  /** "normal" (default) shows the top-image picker; "damage" doesn't — a damage/condition photo is never eligible to be the Inventory's representative image. */
  variant?: "normal" | "damage";
}

// Deliberately never embeds the original filename in the S3 key — only
// letters/digits from its extension, everything else discarded. This
// isn't just tidiness: a key containing a space, parentheses (Windows'
// own "(1)"/"(2)" duplicate-name suffix), or non-ASCII characters
// (ordinary for a real photo's filename) works fine for a plain upload,
// but breaks S3 *copy* — see lib/inventory/imageServerOps.ts's
// copyInventoryImage for why. Keeping upload and copy on the same safe
// key scheme means nothing uploaded from here on can ever hit that.
// Untouched by this pass — used identically for both variants.
function safeUploadPath(file: File): string {
  const match = /\.([a-zA-Z0-9]{1,8})$/.exec(file.name);
  const ext = match ? `.${match[1].toLowerCase()}` : "";
  return `inventory/${crypto.randomUUID()}${ext}`;
}

/**
 * Renders one slot's image at whatever size/fit the caller asks for.
 * Split out from InventoryThumbnail (rather than reused) because that
 * component always crops to fill (`object-cover`) for the list table's
 * fixed-size cells, while this editor's main preview wants
 * `object-contain` — the furniture's actual proportions matter when
 * checking condition/color, spec explicitly calls for preserving aspect
 * ratio here. The small thumbnail strip below the main preview does use
 * `object-cover`, same as everywhere else thumbnails appear, since a
 * cropped square reads fine at that size and a mismatched aspect ratio
 * there would look worse, not better.
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

export function ImageEditor({ slots, onChange, variant = "normal" }: ImageEditorProps) {
  const [dragOver, setDragOver] = useState(false);

  // Always the freshest `slots` prop, read synchronously on every render
  // — kept so async continuations (the upload in handleFilesSelected, in
  // particular) never act on a stale copy.
  //
  // THE BUG THIS FIXES: every mutation here used to read the `slots`
  // variable captured by the render that *started* the operation, not
  // the render current when it *finished*. handleFilesSelected added the
  // new slot(s) via `onChange([...slots, ...newSlots])`, which updates
  // the parent's state and causes a re-render — but the async upload
  // continuation still closed over the OLD pre-upload `slots` array from
  // its own original render. When the upload resolved and called
  // `patchSlot`, that function computed `onChange(slots.map(...))`
  // against that stale array, which never contained the newly-added
  // slot at all — so the "add" a moment earlier was silently reverted
  // the instant the upload finished. That's exactly the reported
  // symptom: the picked image previews for a moment, then disappears,
  // and nothing ends up saved. Reading `slotsRef.current` instead of the
  // closed-over `slots` in every mutator below means each one always
  // operates on whatever is actually current, no matter how much time
  // (an await, a network round trip) passed since it was invoked.
  const slotsRef = useRef(slots);
  slotsRef.current = slots;

  async function handleFilesSelected(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    const newSlots = files.map((file) => ({ file, slot: createNewImageSlot(file) }));
    onChange([...slotsRef.current, ...newSlots.map((n) => n.slot)]);

    await Promise.all(
      newSlots.map(async ({ file, slot }) => {
        const path = safeUploadPath(file);
        try {
          await uploadData({ path, data: file }).result;
          patchSlot(slot.id, { storageKey: path, uploading: false });
        } catch (err) {
          console.error(`[ImageEditor] upload failed for "${file.name}":`, err);
          patchSlot(slot.id, {
            uploading: false,
            error: err instanceof Error ? err.message : "アップロードに失敗しました。もう一度お試しください。",
          });
        }
      }),
    );
  }

  function patchSlot(id: string, patch: Partial<Extract<ImageEditorSlot, { kind: "new" }>>) {
    onChange(slotsRef.current.map((s) => (s.kind === "new" && s.id === id ? { ...s, ...patch } : s)));
  }

  function removeSlot(id: string) {
    const slot = slotsRef.current.find((s) => s.id === id);
    onChange(slotsRef.current.filter((s) => s.id !== id));
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
    //
    // Deleting the current top image needs no special-case cleanup
    // either: resolveTopSlot (and, server-side, resolveTopImage) always
    // recomputes from whatever's left rather than storing "the" top
    // image anywhere else, so removing it just falls through to the
    // next remaining slot automatically — or to "no top image" if none
    // are left. This is exactly spec §4's "トップ画像削除時は安全に次の
    // 画像をトップへ設定する、または未設定状態へ".
  }

  function moveSlot(id: string, direction: -1 | 1) {
    const current = slotsRef.current;
    const index = current.findIndex((s) => s.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= current.length) return;
    const next = [...current];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  /** Marks exactly one slot isPrimary, clearing it on every other — never repositions the array (spec §4: an explicit flag, not "move to front"). Only ever called from the "normal" variant's UI. */
  function setTopImage(id: string) {
    onChange(slotsRef.current.map((s) => ({ ...s, isPrimary: s.id === id })));
  }

  const topSlot = resolveTopSlot(slots);
  const failedUploads = slots.filter((s): s is Extract<ImageEditorSlot, { kind: "new" }> => s.kind === "new" && !!s.error);
  const topLabel = variant === "damage" ? "代表カット" : "トップ画像";

  return (
    <div>
      <ConfigureAmplifyClientSide />
      <label className="block text-[12px] text-gray-600">
        {variant === "damage" ? "複数選択可" : "複数選択可・トップ画像を1枚選択できます"}
      </label>

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

      {/* Exactly ONE large image area — this used to also render a full
          thumbnail-styled card for the top slot again just below it
          (border, label, the works), which for the ordinary single-photo
          case read as the same picture shown twice, large, in two
          places. Below the main preview there is now only ever either
          nothing (0-1 images: a plain 削除 link covers that case) or a
          genuinely small, clearly-secondary thumbnail strip (2+ images)
          — matching how InventoryImageGallery already behaves on the
          detail page. */}
      {slots.length > 0 && topSlot && (
        <div className="mt-3 w-full max-w-sm">
          <EditorImagePreview slot={topSlot} alt={topLabel} className="h-64 w-full border border-gray-200 bg-gray-50 object-contain" />
          <div className="mt-1 flex items-center justify-between">
            <p className="text-[11px] font-bold text-gray-700">
              {topLabel}
              {slots.length > 1 ? `（全${slots.length}枚）` : ""}
            </p>
            <button type="button" onClick={() => removeSlot(topSlot.id)} className="text-[11px] text-red-500 hover:text-red-700">
              この画像を削除
            </button>
          </div>
          {topSlot.kind === "new" && topSlot.uploading && <p className="text-[11px] text-gray-400">アップロード中…</p>}
          {topSlot.kind === "new" && topSlot.error && <p className="text-[11px] text-red-600">{topSlot.error}</p>}
        </div>
      )}

      {slots.length > 1 && (
        <ul className="mt-2 flex max-w-sm flex-wrap gap-2">
          {slots.map((slot, index) => {
            const isTop = slot.id === topSlot?.id;
            return (
              <li key={slot.id} className="w-16">
                <div className={`h-16 w-16 border ${isTop ? "border-gray-900" : "border-gray-200"}`}>
                  <EditorImagePreview
                    slot={slot}
                    alt=""
                    className={`h-full w-full bg-gray-50 object-cover ${slot.kind === "new" && slot.uploading ? "opacity-50" : ""}`}
                  />
                </div>
                {variant === "normal" &&
                  (isTop ? (
                    <p className="mt-0.5 text-center text-[10px] font-bold text-gray-700">★トップ</p>
                  ) : (
                    <button type="button" onClick={() => setTopImage(slot.id)} className="mt-0.5 block w-full text-center text-[10px] text-gray-500 hover:text-gray-900">
                      トップに設定
                    </button>
                  ))}
                <div className="mt-0.5 flex justify-center gap-2 text-[10px] text-gray-400">
                  <button type="button" onClick={() => moveSlot(slot.id, -1)} disabled={index === 0} className="disabled:text-gray-200">
                    ↑
                  </button>
                  <button type="button" onClick={() => moveSlot(slot.id, 1)} disabled={index === slots.length - 1} className="disabled:text-gray-200">
                    ↓
                  </button>
                  <button type="button" onClick={() => removeSlot(slot.id)} className="text-red-400 hover:text-red-600">
                    削除
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {failedUploads.length > 0 && (
        <ul className="mt-2 max-w-sm space-y-0.5">
          {failedUploads.map((s) => (
            <li key={s.id} className="text-[11px] text-red-600">
              {s.error}
            </li>
          ))}
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
