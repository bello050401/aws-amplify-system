import type {InventoryItem} from './inventory';

/** Per signed-in app instance, RAM only. A result is consumed at most once.
 * Every preparation uses the normal authorized GET. No photo bytes are fetched.
 * Never reuse a result for a changed list version, after a write, or reconnect.
 */
export class DetailReadAhead {
  private entries = new Map<string, {version: string; at: number; task: Promise<InventoryItem>}>();
  private generation = 0;
  private active = 0;
  constructor(private load: (id: string) => Promise<InventoryItem>, private now = Date.now) {}
  clear() { this.generation++; this.entries.clear(); }
  private prune() {
    for (const [id, entry] of this.entries) if (this.now() - entry.at > 5000) this.entries.delete(id);
  }
  prepare(id: string, version: string): void {
    this.prune();
    if (!version || this.active >= 2 || this.entries.get(id)?.version === version) return;
    if (this.entries.size >= 2) this.entries.delete(this.entries.keys().next().value!);
    const generation = this.generation;
    this.active++;
    const entry = {version, at: this.now(), task: Promise.resolve(null as unknown as InventoryItem)};
    entry.task = this.load(id).then(item => {
      if (item.id !== id) throw new Error('Detail identity mismatch');
      // Bound retained metadata as well as count. Large records still work via
      // the ordinary read. Stale pending work cannot repopulate a cleared cache.
      if (generation !== this.generation || JSON.stringify(item).length > 65536) {
        if (this.entries.get(id) === entry) this.entries.delete(id);
      }
      return item;
    }).finally(() => {this.active--;});
    this.entries.set(id, entry);
    void entry.task.catch(() => {if (this.entries.get(id) === entry) this.entries.delete(id);});
  }
  read(id: string, version?: string): Promise<InventoryItem> {
    this.prune();
    const entry = this.entries.get(id);
    this.entries.delete(id);
    return entry && version && entry.version === version ? entry.task : this.load(id);
  }
}
