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
// `sourceSystem`/`sourceUrl` (ZAICO sync) ride along on every slot, not
// just "existing" — a uniform shape means resolveTopSlot and the other
// shared helpers below never need to know which kind they're looking at
// to read these. Only "existing" (an image already on the record being
// edited) ever has non-null values in practice: a freshly picked file
// ("new") is never ZAICO's by construction, and a duplicated record
// ("copy") is a brand-new, non-ZAICO-managed Inventory — see
// NewInventoryForm's slotsFromImages for why that one deliberately drops
// the tag rather than carrying it over. Preserving these through a plain
// edit-and-save (an "existing" slot the user never touched) is what
// keeps the ZAICO sync able to find "its" image on the next sync instead
// of mistaking it for a BELLO photo and importing a duplicate — see
// app/actions/inventory.ts's resolveImages.
export type ImageEditorSlot =
  | {
      id: string;
      kind: "new";
      localPreviewUrl: string;
      storageKey: string | null;
      uploading: boolean;
      error: string | null;
      isPrimary: boolean;
      sourceSystem: string | null;
      sourceUrl: string | null;
    }
  | { id: string; kind: "existing"; storageKey: string; isPrimary: boolean; sourceSystem: string | null; sourceUrl: string | null }
  | { id: string; kind: "copy"; sourceStorageKey: string; isPrimary: boolean; sourceSystem: string | null; sourceUrl: string | null };

export function createNewImageSlot(file: File): ImageEditorSlot {
  return {
    id: crypto.randomUUID(),
    kind: "new",
    localPreviewUrl: URL.createObjectURL(file),
    storageKey: null,
    uploading: true,
    error: null,
    isPrimary: false,
    sourceSystem: null,
    sourceUrl: null,
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
  // "選択中の画像（大きく見るためにクリックしただけ）" と
  // "トップ画像（isPrimary）" は別概念 (統合改善指示書 §3/§6) —
  // クリックはこのローカルstateだけを動かし、slots/isPrimaryには一切
  // 触れない。null = 「まだ何もクリックしていない」= 従来どおり
  // resolveTopSlotへフォールバック(下のdisplaySlot参照)。保存対象では
  // ないため、フォームの他のstateと違いonChangeを経由しない —
  // ページを離れれば消えて構わない、純粋な表示上の選択でしかない。
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  /**
   * Manual ↑/↓ reorder — never allowed to move the current top image
   * (isPrimary) out of the front position, or move anything else into
   * it (統合改善指示書 §7: トップ画像=isPrimary=true=sortOrder先頭の不
   * 変条件は、この既存の並び替え操作と組み合わせても崩れてはいけな
   * い). Everything else (positions after the top image) still reorders
   * freely among itself exactly as before. When nothing is explicitly
   * primary yet (a fresh multi-upload before the user has picked one),
   * every slot's `isPrimary` is false and this guard is a no-op — index
   * 0 is only an implicit fallback top image at that point (see
   * resolveTopSlot), not a guarantee worth locking in place.
   */
  function moveSlot(id: string, direction: -1 | 1) {
    const current = slotsRef.current;
    const index = current.findIndex((s) => s.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= current.length) return;
    if (current[index].isPrimary || current[target].isPrimary) return;
    const next = [...current];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  /**
   * Marks exactly one slot isPrimary, clearing it on every other, AND
   * moves it to the front of the array (統合改善指示書 §6/§7 — revised
   * from this function's earlier "never repositions" behavior: トップ
   * 画像 = サムネイル一覧の一番左, so the array order itself must carry
   * that, not just the isPrimary flag). Everything else keeps its prior
   * *relative* order — this is a stable move-to-front, not a full
   * re-sort. sortOrder itself isn't tracked on the client-side slot at
   * all; it's only ever assigned at flatten-time from each slot's array
   * position (see NewInventoryForm/EditInventoryForm's
   * slotsToImageInputs) — so this reordering alone is what keeps
   * isPrimary=true and sortOrder=0 aligned on save, with no separate
   * sortOrder bookkeeping needed here. Only ever called from the
   * "normal" variant's UI — a damage/condition photo can never become
   * the top image, by construction.
   *
   * Also selects this slot for the big preview (setSelectedId) — a
   * deliberate act of "make this my top image" is a reasonable moment to
   * also show it large, even though merely *clicking* a thumbnail for
   * preview never does the reverse (sets isPrimary).
   */
  function setTopImage(id: string) {
    const current = slotsRef.current;
    const target = current.find((s) => s.id === id);
    if (!target) return;
    const rest = current.filter((s) => s.id !== id);
    onChange([{ ...target, isPrimary: true }, ...rest.map((s) => (s.isPrimary ? { ...s, isPrimary: false } : s))]);
    setSelectedId(id);
  }

  const topSlot = resolveTopSlot(slots);
  // 「大きく表示している画像」— 明示的にクリックされたものがあればそ
  // れ、なければ従来どおりトップ画像優先(spec変更前の挙動と完全互換)。
  // クリック後にその画像が削除された等でslotsから消えていた場合も、
  // 毎レンダー計算し直すこの形なら自然にtopSlotへフォールバックする
  // (別途クリーンアップ用のuseEffectが要らない)。
  const displaySlot = (selectedId && slots.find((s) => s.id === selectedId)) || topSlot;
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
          detail page.
          Shows `displaySlot` (whichever thumbnail was last clicked,
          falling back to the top slot) — NOT unconditionally `topSlot`
          anymore (統合改善指示書 §3: 選択画像とトップ画像は別概念)。
          `items-center justify-center` makes the centering explicit
          rather than relying only on object-contain's default
          object-position, so a narrow/tall or wide/short photo can never
          read as pinned to one edge (spec §4). */}
      {slots.length > 0 && displaySlot && (
        <div className="mt-3 w-full max-w-sm">
          <div className="flex h-64 w-full items-center justify-center border border-gray-200 bg-gray-50">
            <EditorImagePreview slot={displaySlot} alt={topLabel} className="h-full w-full object-contain" />
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <p className="text-[11px] font-bold text-gray-700">
              {displaySlot.id === topSlot?.id ? topLabel : "選択中の画像"}
              {slots.length > 1 ? `（全${slots.length}枚）` : ""}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              {variant === "normal" && displaySlot.id !== topSlot?.id && (
                <button type="button" onClick={() => setTopImage(displaySlot.id)} className="text-[11px] text-gray-500 hover:text-gray-900">
                  トップ画像に設定
                </button>
              )}
              <button type="button" onClick={() => removeSlot(displaySlot.id)} className="text-[11px] text-red-500 hover:text-red-700">
                この画像を削除
              </button>
            </div>
          </div>
          {displaySlot.kind === "new" && displaySlot.uploading && <p className="text-[11px] text-gray-400">アップロード中…</p>}
          {displaySlot.kind === "new" && displaySlot.error && <p className="text-[11px] text-red-600">{displaySlot.error}</p>}
        </div>
      )}

      {slots.length > 1 && (
        <ul className="mt-2 flex max-w-sm flex-wrap gap-2">
          {slots.map((slot, index) => {
            const isTop = slot.id === topSlot?.id;
            const isSelected = slot.id === displaySlot?.id;
            return (
              <li key={slot.id} className="w-16">
                {/* サムネイルをクリック = 大きく見るためだけの選択
                    (isPrimary/sortOrderには一切触れない、spec §3)。 */}
                <button
                  type="button"
                  onClick={() => setSelectedId(slot.id)}
                  aria-label={`${index + 1}枚目を大きく表示`}
                  className={`block h-16 w-16 border ${isSelected ? "border-gray-900" : isTop ? "border-gray-400" : "border-gray-200"}`}
                >
                  <EditorImagePreview
                    slot={slot}
                    alt=""
                    className={`h-full w-full bg-gray-50 object-cover ${slot.kind === "new" && slot.uploading ? "opacity-50" : ""}`}
                  />
                </button>
                {variant === "normal" &&
                  (isTop ? (
                    <p className="mt-0.5 text-center text-[10px] font-bold text-gray-700">★トップ</p>
                  ) : (
                    <button type="button" onClick={() => setTopImage(slot.id)} className="mt-0.5 block w-full text-center text-[10px] text-gray-500 hover:text-gray-900">
                      トップに設定
                    </button>
                  ))}
                <div className="mt-0.5 flex justify-center gap-2 text-[10px] text-gray-400">
                  {/* ↑/↓は通常のスワップに加えて、トップ画像(isPrimary)
                      を先頭から動かす／先頭へ割り込む操作は無効化する
                      — moveSlot自体のガードと矛盾しないよう、押せない
                      場合はボタン自体もdisabledにする(spec §7)。 */}
                  <button
                    type="button"
                    onClick={() => moveSlot(slot.id, -1)}
                    disabled={index === 0 || slot.isPrimary || slots[index - 1]?.isPrimary}
                    className="disabled:text-gray-200"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => moveSlot(slot.id, 1)}
                    disabled={index === slots.length - 1 || slot.isPrimary || slots[index + 1]?.isPrimary}
                    className="disabled:text-gray-200"
                  >
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
