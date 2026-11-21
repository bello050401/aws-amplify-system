import type { CatalogGrant, PublicCatalogItem } from './partnerCatalog/types';

export interface CatalogSelectionData { grant: CatalogGrant; candidates: PublicCatalogItem[]; maxSelectedItems: number; imageHeaders?: Record<string, string> }
export interface CatalogSelectionPorts {
  list(): Promise<CatalogGrant[]>;
  read(id: string): Promise<CatalogSelectionData>;
  save(id: string, revision: number, selectedIds: string[]): Promise<CatalogGrant>;
  link(path: string): string;
  copy(text: string): Promise<void | boolean>;
  copyLabel?: string;
  copyNotice?: string;
  open(url: string): Promise<void>;
}
export class CatalogSelectionError extends Error { constructor(public code: 'conflict' | 'unavailable' | 'forbidden', message: string) { super(message); } }
export interface CatalogSelectionState { grants: CatalogGrant[]; id: string; data: CatalogSelectionData | null; draft: string[]; loading: boolean; saving: boolean; error: string; notice: string; conflict: boolean }
export function selectionDirty(state: CatalogSelectionState): boolean {
  const saved = state.data?.grant.selectedIds ?? [];
  return saved.length !== state.draft.length || saved.some(id => !state.draft.includes(id));
}
/** One explicit draft per link. Read failures and uncertain saves never discard it. */
export class CatalogSelectionController {
  state: CatalogSelectionState = { grants: [], id: '', data: null, draft: [], loading: false, saving: false, error: '', notice: '', conflict: false };
  private drafts = new Map<string, string[]>();
  private listeners = new Set<(state: CatalogSelectionState) => void>();
  private generation = 0;
  constructor(public ports: CatalogSelectionPorts) {}
  subscribe(listener: (state: CatalogSelectionState) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private update(change: Partial<CatalogSelectionState>) { this.state = { ...this.state, ...change }; for (const listener of this.listeners) listener(this.state); }
  reset() {
    this.generation++; this.drafts.clear();
    this.update({ grants: [], id: '', data: null, draft: [], loading: false, saving: false, error: '', notice: '', conflict: false });
  }
  async start() {
    if (this.state.loading || this.state.saving) return;
    const generation = ++this.generation;
    this.update({ loading: true, error: '' });
    try {
      const grants = await this.ports.list(); if (generation !== this.generation) return; this.update({ grants, loading: false });
      if (grants.length) await this.choose(this.state.id && grants.some(g => g.id === this.state.id) ? this.state.id : grants[0].id);
    } catch { if (generation === this.generation) this.update({ loading: false, error: '共有リンクを取得できませんでした。通信を確認して再読み込みしてください。' }); }
  }
  async choose(id: string, keepDraft = true) {
    if (this.state.saving) return;
    if (this.state.data) {
      if (selectionDirty(this.state)) this.drafts.set(this.state.id, [...this.state.draft]);
      else this.drafts.delete(this.state.id);
    }
    const generation = ++this.generation;
    this.update({ id, loading: true, data: this.state.id === id ? this.state.data : null, error: '', notice: '', conflict: false });
    try {
      const data = await this.ports.read(id);
      if (generation !== this.generation) return;
      const retained = keepDraft ? this.drafts.get(id) : undefined;
      const draft = retained ? [...retained] : [...data.grant.selectedIds];
      this.update({ data, draft, loading: false, notice: retained ? '最新の共有内容を取得しました。未保存の選択は保持しています。内容を確認して保存してください。' : '' });
    } catch { if (generation === this.generation) this.update({ loading: false, error: '商品を取得できませんでした。未保存の選択は保持しています。通信を確認して再試行してください。' }); }
  }
  toggle(id: string) {
    if (this.state.loading || this.state.saving || !this.state.data?.candidates.some(item => item.id === id)) return;
    const draft = this.state.draft.includes(id) ? this.state.draft.filter(value => value !== id) : [...this.state.draft, id];
    if (draft.length > this.state.data.maxSelectedItems) { this.update({ error: `選択できるのは${this.state.data.maxSelectedItems}件までです。` }); return; }
    this.drafts.set(this.state.id, draft); this.update({ draft, error: '', notice: '' });
  }
  clear() { if (!this.state.loading && !this.state.saving) { this.drafts.set(this.state.id, []); this.update({ draft: [], error: '', notice: '' }); } }
  removeUnavailable() {
    if (!this.state.data || this.state.loading || this.state.saving) return;
    const available = new Set(this.state.data.candidates.map(item => item.id));
    const draft = this.state.draft.filter(id => available.has(id));
    this.drafts.set(this.state.id, draft); this.update({ draft, notice: '', error: '' });
  }
  async save() {
    const { data, id, draft, loading, saving, conflict } = this.state;
    if (!data || loading || saving || conflict || !selectionDirty(this.state)) return;
    const generation = this.generation;
    this.update({ saving: true, error: '', notice: '' });
    try {
      const grant = await this.ports.save(id, data.grant.revision, [...draft]);
      if (generation !== this.generation) return;
      this.drafts.delete(id);
      this.update({ data: { ...data, grant }, draft: [...grant.selectedIds], grants: this.state.grants.map(g => g.id === id ? grant : g), saving: false, notice: '共有する商品を保存しました。既存のリンクに反映されました。' });
    } catch (error) {
      if (generation !== this.generation) return;
      const conflict = error instanceof CatalogSelectionError && error.code === 'conflict';
      this.update({ saving: false, conflict, error: conflict ? '別の端末で更新されました。最新内容を再読み込みし、保持した選択を確認してから保存してください。' : '保存を確認できませんでした。選択は保持しています。通信を確認して再試行してください。' });
    }
  }
  async copy() { if (!this.state.data) return; try { const result = await this.ports.copy(this.ports.link(this.state.data.grant.path)); if (result !== false) this.update({ notice: this.ports.copyNotice ?? '共有リンクをコピーしました。', error: '' }); } catch { this.update({ error: 'リンクを共有できませんでした。共有リンク欄からコピーしてください。' }); } }
  async open() { if (!this.state.data) return; try { await this.ports.open(this.ports.link(this.state.data.grant.path)); } catch { this.update({ error: '共有ページを開けませんでした。' }); } }
}
