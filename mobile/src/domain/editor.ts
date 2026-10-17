import { draftFor, sameDraft, validateDraft, type InventoryDraft, type InventoryItem } from "./inventory";
import { DETAIL_FIELDS, copyDetailValues } from "./detailFields";
import type { PendingPhoto, UploadedPhoto } from "./inventory";

export const OFFLINE_WARNING = "【圏外です】";
export type WriteFailure = "offline" | "unauthorized" | "forbidden" | "conflict" | "uncertain" | "server";
export class InventoryWriteError extends Error {
  constructor(readonly kind: WriteFailure) { super(kind); }
}

export interface SaveRequest {
  id: string;
  expectedUpdatedAt: string;
  mutationId: string;
  draft: InventoryDraft;
  create?: boolean;
  uploads?: UploadedPhoto[];
}
export interface EditorPorts {
  online: () => Promise<boolean>;
  save: (request: SaveRequest) => Promise<InventoryItem>;
  newMutationId: () => string;
  uploadPhoto?: (photo: PendingPhoto) => Promise<UploadedPhoto>;
}
export interface EditorState {
  saved: InventoryItem;
  draft: InventoryDraft;
  dirty: boolean;
  saving: boolean;
  leaveConfirmation: boolean;
  warning: string | null;
  outcomeUncertain: boolean;
  photos: PendingPhoto[];
  creating: boolean;
}

const errors: Record<WriteFailure, string> = {
  offline: OFFLINE_WARNING,
  unauthorized: "ログインの有効期限が切れました。編集内容は保持しています。",
  forbidden: "変更する権限がありません。編集内容は保持しています。",
  conflict: "別の操作で商品が更新されています。最新の内容を確認してください。編集内容は保持しています。",
  uncertain: "保存結果を確認できません。編集内容は保持しています。通信回復後に保存状況を確認してください。",
  server: "保存できませんでした。編集内容は保持しています。",
};

/** No reconnect listener or write queue: every write starts with an explicit save. */
export class InventoryEditor {
  private state: EditorState;
  private listeners = new Set<() => void>();
  private pendingRequest: SaveRequest | null = null;
  private uploaded = new Map<string, UploadedPhoto>();

  constructor(item: InventoryItem, private readonly ports: EditorPorts, creating = false) {
    this.state = {
      saved: { ...item, details: copyDetailValues(item.details) }, draft: draftFor(item), dirty: false, saving: false,
      leaveConfirmation: false, warning: null, outcomeUncertain: false,
      photos: [], creating,
    };
  }

  getSnapshot = (): EditorState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private set(patch: Partial<EditorState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  change<K extends keyof InventoryDraft>(key: K, value: InventoryDraft[K]): void {
    // An unacknowledged request must be reconciled before sending a different body.
    if (this.state.saving || this.state.outcomeUncertain) return;
    const draft = { ...this.state.draft, [key]: key === "details" ? copyDetailValues(value) : value };
    this.pendingRequest = null;
    this.set({ draft, dirty: this.state.photos.length > 0 || !sameDraft(draft, draftFor(this.state.saved)), warning: null });
  }

  changeDetail(key: string, value: string): void {
    const field = DETAIL_FIELDS.find(item => item.key === key);
    if (!field || field.readOnly) return;
    this.change("details", { ...this.state.draft.details, [key]: value });
  }

  chooseStatus(id: string): void {
    if (this.state.saving || this.state.outcomeUncertain || !this.state.saved.statusOptions) return;
    const selected = this.state.saved.statusOptions.find(option => option.id === id);
    if (id && !selected) return;
    const draft = { ...this.state.draft, statusId: id, condition: selected?.label ?? "" };
    this.pendingRequest = null;
    this.set({ draft, dirty: this.state.photos.length > 0 || !sameDraft(draft, draftFor(this.state.saved)), warning: null });
  }

  addPhotos(photos: PendingPhoto[]): void {
    if (this.state.saving || this.state.outcomeUncertain) return;
    this.pendingRequest = null;
    this.set({ photos: [...this.state.photos, ...photos], dirty: true, warning: null });
  }
  removePhoto(id: string): void {
    if (this.state.saving || this.state.outcomeUncertain) return;
    const photos = this.state.photos.filter(photo => photo.id !== id);
    this.pendingRequest = null;
    this.set({ photos, dirty: photos.length > 0 || !sameDraft(this.state.draft, draftFor(this.state.saved)) });
  }

  requestLeave(): boolean {
    if (this.state.saving) return false;
    if (!this.state.dirty) return true;
    this.set({ leaveConfirmation: true });
    return false;
  }

  continueEditing(): void { this.set({ leaveConfirmation: false }); }

  discard(): boolean {
    if (this.state.saving) return false;
    // Discarding local fields never rolls back a possibly completed server write.
    this.set({ draft: draftFor(this.state.saved), photos: [], dirty: false, leaveConfirmation: false, warning: null });
    this.pendingRequest = null;
    return true;
  }

  async save(): Promise<InventoryItem | null> {
    if (this.state.saving) return null;
    if (!this.state.dirty && !this.state.creating) return this.state.saved;
    this.set({ saving: true, warning: null });
    try {
      if (!await this.ports.online()) {
        this.set({ warning: OFFLINE_WARNING });
        return null;
      }
      const validation = validateDraft(this.state.draft);
      if (validation) { this.set({ warning: validation }); return null; }
      // Upload only on explicit save. Failed uploads have not submitted an Inventory write.
      const uploads: UploadedPhoto[] = [];
      if (!this.pendingRequest) for (const photo of this.state.photos) {
        try {
          if (!this.ports.uploadPhoto) throw new Error("Unavailable");
          const uploaded = this.uploaded.get(photo.id) ?? await this.ports.uploadPhoto(photo);
          this.uploaded.set(photo.id, uploaded); uploads.push(uploaded);
        } catch {
          this.set({ warning: await this.ports.online().catch(() => false) ? "写真を保存できませんでした。入力と写真は保持しています。" : OFFLINE_WARNING });
          return null;
        }
      }
      const request = this.pendingRequest ?? {
        id: this.state.saved.id, expectedUpdatedAt: this.state.saved.updatedAt,
        mutationId: this.ports.newMutationId(), draft: { ...this.state.draft, details: copyDetailValues(this.state.draft.details) },
        ...(this.state.creating ? { create: true } : {}), ...(uploads.length ? { uploads } : {}),
      };
      this.pendingRequest = request;
      const saved = await this.ports.save(request);
      if (saved.id !== request.id) throw new InventoryWriteError("uncertain");
      this.pendingRequest = null;
      this.set({ saved: { ...saved, details: copyDetailValues(saved.details) }, draft: draftFor(saved), dirty: false,
        leaveConfirmation: false, warning: null, outcomeUncertain: false });
      this.set({ creating: false, photos: [] });
      return saved;
    } catch (error) {
      const kind = error instanceof InventoryWriteError ? error.kind : "uncertain";
      // A transport exception after sending is NOT proof that the write failed.
      this.set({ warning: errors[kind], outcomeUncertain: this.state.outcomeUncertain || kind === "uncertain" });
      return null;
    } finally {
      this.set({ saving: false });
    }
  }
}
