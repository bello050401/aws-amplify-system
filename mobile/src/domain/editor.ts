import { draftFor, sameDraft, validateDraft, type InventoryDraft, type InventoryItem } from "./inventory";
import { DETAIL_FIELDS, copyDetailValues } from "./detailFields";

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
}
export interface EditorPorts {
  online: () => Promise<boolean>;
  save: (request: SaveRequest) => Promise<InventoryItem>;
  newMutationId: () => string;
}
export interface EditorState {
  saved: InventoryItem;
  draft: InventoryDraft;
  dirty: boolean;
  saving: boolean;
  leaveConfirmation: boolean;
  warning: string | null;
  outcomeUncertain: boolean;
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

  constructor(item: InventoryItem, private readonly ports: EditorPorts) {
    this.state = {
      saved: { ...item, details: copyDetailValues(item.details) }, draft: draftFor(item), dirty: false, saving: false,
      leaveConfirmation: false, warning: null, outcomeUncertain: false,
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
    this.set({ draft, dirty: !sameDraft(draft, draftFor(this.state.saved)), warning: null });
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
    this.set({ draft, dirty: !sameDraft(draft, draftFor(this.state.saved)), warning: null });
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
    this.set({ draft: draftFor(this.state.saved), dirty: false, leaveConfirmation: false, warning: null });
    this.pendingRequest = null;
    return true;
  }

  async save(): Promise<InventoryItem | null> {
    if (this.state.saving) return null;
    if (!this.state.dirty) return this.state.saved;
    this.set({ saving: true, warning: null });
    try {
      if (!await this.ports.online()) {
        this.set({ warning: OFFLINE_WARNING });
        return null;
      }
      const validation = validateDraft(this.state.draft);
      if (validation) { this.set({ warning: validation }); return null; }
      const request = this.pendingRequest ?? {
        id: this.state.saved.id, expectedUpdatedAt: this.state.saved.updatedAt,
        mutationId: this.ports.newMutationId(), draft: { ...this.state.draft, details: copyDetailValues(this.state.draft.details) },
      };
      this.pendingRequest = request;
      const saved = await this.ports.save(request);
      if (saved.id !== request.id) throw new InventoryWriteError("uncertain");
      this.pendingRequest = null;
      this.set({ saved: { ...saved, details: copyDetailValues(saved.details) }, draft: draftFor(saved), dirty: false,
        leaveConfirmation: false, warning: null, outcomeUncertain: false });
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
