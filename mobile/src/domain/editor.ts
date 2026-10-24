import { draftFor, sameDraft, validateDraft, type InventoryDraft, type InventoryItem } from "./inventory";
import { DETAIL_FIELDS, copyDetailValues } from "./detailFields";
import type { PendingPhoto, UploadedPhoto } from "./inventory";
import {splitCategoryNames} from '../../../lib/inventory/categories';

export const OFFLINE_WARNING = "【圏外です】";
export type WriteFailure = "offline" | "unauthorized" | "forbidden" | "conflict" | "uncertain" | "server" | "barcodeInvalid" | "outboundReserved" | "categoryInvalid";
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
  removedPhotoIds?: string[];
  copyFrom?: { id: string; updatedAt: string };
}
export interface EditorPorts {
  online: () => Promise<boolean>;
  save: (request: SaveRequest) => Promise<InventoryItem>;
  newMutationId: () => string;
  deletePhotoAsset?: (id:string,photoId:string)=>Promise<void>;
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
  removedPhotoIds: string[];
  creating: boolean;
}

const errors: Record<WriteFailure, string> = {
  barcodeInvalid: '読み取れませんでした。番号を確認してください。',
  outboundReserved: '出庫データを作成済みです。出庫画面で送信を完了するか、未送信データを取り消してから編集してください。',
  categoryInvalid: 'カテゴリを確認してください。最新の一覧から20個以内で選択してください。',
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

  constructor(item: InventoryItem, private readonly ports: EditorPorts, creating = false, private readonly copyFrom?: SaveRequest["copyFrom"]) {
    this.state = {
      saved: { ...item, details: copyDetailValues(item.details) }, draft: draftFor(item), dirty: Boolean(copyFrom), saving: false,
      leaveConfirmation: false, warning: null, outcomeUncertain: false,
      photos: [], removedPhotoIds: [], creating,
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
    this.set({ draft, dirty: this.state.photos.length > 0 || this.state.removedPhotoIds.length > 0 || !sameDraft(draft, draftFor(this.state.saved)), warning: null });
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
    this.set({ draft, dirty: this.state.photos.length > 0 || this.state.removedPhotoIds.length > 0 || !sameDraft(draft, draftFor(this.state.saved)), warning: null });
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
    this.set({ photos, dirty: photos.length > 0 || this.state.removedPhotoIds.length > 0 || !sameDraft(this.state.draft, draftFor(this.state.saved)) });
  }

  removeSavedPhoto(id: string): void {
    if (this.state.saving || this.state.outcomeUncertain || this.state.creating || this.state.saved.photosComplete !== true) return;
    if (!this.state.saved.photos?.some(photo => photo.id === id && photo.source === "INVENTORY")) return;
    this.pendingRequest = null;
    this.set({ removedPhotoIds: [...new Set([...this.state.removedPhotoIds, id])], dirty: true, warning: null });
  }

  async deletePhotoAsset(id:string):Promise<InventoryItem>{
    if(this.state.saving||this.state.outcomeUncertain||this.state.creating||!this.ports.deletePhotoAsset||!this.state.saved.photos?.some(p=>p.id===id&&p.source==='PHOTO_ASSET'))throw new Error('写真を確認してから再度お試しください。');
    this.set({saving:true});
    try{if(!await this.ports.online())throw new Error(OFFLINE_WARNING);
      await this.ports.deletePhotoAsset(this.state.saved.id,id);
      const photos=this.state.saved.photos!.filter(p=>p.id!==id);
      const primary=photos.find(p=>p.primary)??photos[0];
      const saved={...this.state.saved,photos,thumbnailUrl:primary?.url??null};
      this.set({saved});return saved;
    }finally{this.set({saving:false});}
  }

  restoreRemovedPhotos(): void {
    if (this.state.saving || this.state.outcomeUncertain) return;
    this.pendingRequest = null;
    this.set({ removedPhotoIds: [], dirty: this.state.photos.length > 0 || !sameDraft(this.state.draft, draftFor(this.state.saved)) });
  }

  requestLeave(): boolean {
    if (this.state.saving) return false;
    if (!this.state.dirty && !this.copyFrom) return true;
    this.set({ leaveConfirmation: true });
    return false;
  }

  continueEditing(): void { this.set({ leaveConfirmation: false }); }

  discard(): boolean {
    if (this.state.saving) return false;
    // Keep the request identity until a possibly committed write is reconciled.
    // Discarding it cannot undo the write and would make a later retry unsafe.
    if (this.state.outcomeUncertain) {
      this.set({ warning: errors.uncertain, leaveConfirmation: true });
      return false;
    }
    this.set({ draft: draftFor(this.state.saved), photos: [], removedPhotoIds: [], dirty: false, leaveConfirmation: false, warning: null });
    this.pendingRequest = null;
    return true;
  }

  /** QR and movement are one server transaction. Cancel/rejection never leaves half a draft. */
  async saveQrMovement(value:string,category:string|null,movementNames:string[]):Promise<InventoryItem|null> {
    if(this.state.saving)return null;
    if(this.state.outcomeUncertain)return this.save();
    const previous={barcode:this.state.draft.barcode,category:this.state.draft.category};
    this.change('barcode',value.trim());
    if(category)this.change('category',[...splitCategoryNames(previous.category).filter(c=>!movementNames.includes(c)),category].join(','));
    const result=await this.save();
    if(!result&&!this.state.outcomeUncertain){const warning=this.state.warning;this.change('barcode',previous.barcode);this.change('category',previous.category);this.set({warning});}
    return result;
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
        ...(this.state.removedPhotoIds.length ? { removedPhotoIds: [...this.state.removedPhotoIds] } : {}),
        ...(this.copyFrom ? { copyFrom: this.copyFrom } : {}),
      };
      this.pendingRequest = request;
      const saved = await this.ports.save(request);
      if (saved.id !== request.id) throw new InventoryWriteError("uncertain");
      this.pendingRequest = null;
      this.set({ saved: { ...saved, details: copyDetailValues(saved.details) }, draft: draftFor(saved), dirty: false,
        leaveConfirmation: false, warning: null, outcomeUncertain: false });
      this.set({ creating: false, photos: [], removedPhotoIds: [] });
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
