import 'server-only';
import { CatalogError, type StoredGrant } from './grants';
import { catalogImageKey, eligibleStage, publicCatalogItem, validInventoryId, validToken, type CatalogCategories, type Row } from './policy';
import type { PublicCatalogResponse, PublicCatalogItem } from './types';

export type PartnerCatalogPorts = {
  authorize: (token: string) => Promise<StoredGrant | null>;
  categories: () => Promise<CatalogCategories>;
  rows: (categories: CatalogCategories) => Promise<Row[]>;
  byIds?: (ids: string[]) => Promise<Row[]>;
  one: (id: string) => Promise<Row | null>;
  image: (key: string) => Promise<{ bytes: Uint8Array; contentType: string }>;
  now?: () => number;
};
const missing = () => new CatalogError(404, 'この共有リンクは利用できません。');
const selected = (grant: StoredGrant, id: unknown) => Array.isArray(grant.selectedIds) && grant.selectedIds.includes(String(id));
const order = (a: PublicCatalogItem, b: PublicCatalogItem) => a.managementNumber.localeCompare(b.managementNumber, 'ja', { numeric: true }) || a.id.localeCompare(b.id);
/** There is no unauthenticated general inventory/S3 primitive. Both reads start at a capability. */
export function createPartnerCatalogService(ports: PartnerCatalogPorts) {
  const now = ports.now ?? Date.now;
  async function grant(token: string) {
    if (!validToken(token)) throw missing();
    const grant = await ports.authorize(token);
    if (!grant || grant.disabled || Date.parse(grant.expiresAt) <= now()) throw missing();
    return grant;
  }
  async function read(token: string): Promise<PublicCatalogResponse> {
    const allowed = await grant(token);
    const categories = await ports.categories();
    const ids = allowed.selectedIds ?? [];
    const rows = ids.length ? (ports.byIds ? await ports.byIds(ids) : await ports.rows(categories)) : [];
    // The final authorization follows every data await. Selection edits immediately
    // remove old IDs; concurrent additions wait until the next read.
    const current = await grant(token);
    const chosen = rows.filter(row => selected(allowed, row.id) && selected(current, row.id));
    const items = chosen.map(row => publicCatalogItem(row, categories, token)).filter((row): row is NonNullable<typeof row> => row !== null).sort(order);
    const timestamps = chosen.filter(row => eligibleStage(row, categories)).map(row => Date.parse(String(row.updatedAt ?? row.listUpdatedAt ?? ''))).filter(Number.isFinite);
    return { ok: true, title: current.title, expiresAt: current.expiresAt, checkedAt: new Date(now()).toISOString(),
      updatedAt: new Date(Math.max(Date.parse(current.updatedAt), ...timestamps)).toISOString(), items };
  }
  async function image(token: string, id: string, index: number, full = false) {
    const initial = await grant(token);
    if (!selected(initial, id)) throw missing();
    return authorizedImage(id, index, full, async () => { if (!selected(await grant(token), id)) throw missing(); });
  }
  async function authorizedImage(id: string, index: number, full: boolean, authorize: () => Promise<unknown>) {
    if (!validInventoryId(id) || !Number.isSafeInteger(index) || index < 0 || index >= 20) throw missing();
    await authorize();
    const categories = await ports.categories();
    const row = await ports.one(id);
    if (!row || row.id !== id || !eligibleStage(row, categories)) throw missing();
    const key = catalogImageKey(row, index, full);
    if (!key) throw missing();
    await authorize();
    const result = await ports.image(key);
    // Stock/category/photo changes during the object read revoke that response too.
    const currentCategories = await ports.categories();
    const current = await ports.one(id);
    if (!current || current.id !== id || !eligibleStage(current, currentCategories) || catalogImageKey(current, index, full) !== key) throw missing();
    await authorize();
    return result;
  }
  async function candidates(authorize: () => Promise<unknown>): Promise<PublicCatalogItem[]> {
    await authorize();
    const categories = await ports.categories();
    const rows = await ports.rows(categories);
    const items = rows.map((row): PublicCatalogItem | null => {
      const item = publicCatalogItem(row, categories, '');
      if (!item) return null;
      const images = item.images.map((_, index) => '/api/inventory/partner-catalog/image/' + item.id + '?index=' + index);
      return { ...item, imageUrl: images[0] ?? null, images };
    }).filter((item): item is PublicCatalogItem => item !== null).sort(order);
    await authorize();
    return items;
  }
  async function validateSelection(ids: string[]) {
    const categories = await ports.categories();
    const rows = ports.byIds ? await ports.byIds(ids) : await Promise.all(ids.map(id => ports.one(id)));
    const eligible = new Set(rows.filter((row): row is Row => !!row && !!eligibleStage(row, categories)).map(row => row.id));
    if (ids.some(id => !eligible.has(id))) throw new CatalogError(400, '対象外または在庫が変更された商品があります。再読み込みしてください。');
  }
  return { read, image, candidates, validateSelection, adminImage: (id: string, index: number, authorize: () => Promise<unknown>) => authorizedImage(id, index, false, authorize) };
}
