import 'server-only';
import { CatalogError, type StoredGrant } from './grants';
import { catalogImageKey, eligibleStage, publicCatalogItem, validInventoryId, validToken, type CatalogCategories, type Row } from './policy';
import type { PublicCatalogResponse } from './types';

export type PartnerCatalogPorts = {
  authorize: (token: string) => Promise<StoredGrant | null>;
  categories: () => Promise<CatalogCategories>;
  rows: (categories: CatalogCategories) => Promise<Row[]>;
  one: (id: string) => Promise<Row | null>;
  image: (key: string) => Promise<{ bytes: Uint8Array; contentType: string }>;
  now?: () => number;
};
const missing = () => new CatalogError(404, 'この共有リンクは利用できません。');
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
    const rows = await ports.rows(categories);
    const items = rows.map(row => publicCatalogItem(row, categories, token)).filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => a.managementNumber.localeCompare(b.managementNumber, 'ja', { numeric: true }) || a.id.localeCompare(b.id));
    // Disable/renew/expiry during a slower read also fails closed.
    await grant(token);
    const timestamps = rows.filter(row => eligibleStage(row, categories)).map(row => Date.parse(String(row.updatedAt ?? row.listUpdatedAt ?? ''))).filter(Number.isFinite);
    return { ok: true, title: allowed.title, expiresAt: allowed.expiresAt, checkedAt: new Date(now()).toISOString(),
      updatedAt: new Date(Math.max(Date.parse(allowed.updatedAt), ...timestamps)).toISOString(), items };
  }
  async function image(token: string, id: string, index: number) {
    await grant(token);
    if (!validInventoryId(id) || !Number.isSafeInteger(index) || index < 0 || index >= 20) throw missing();
    const categories = await ports.categories();
    const row = await ports.one(id);
    if (!row || row.id !== id || !eligibleStage(row, categories)) throw missing();
    const key = catalogImageKey(row, index);
    if (!key) throw missing();
    const result = await ports.image(key);
    await grant(token);
    // Stock/category/photo changes during the object read revoke that response too.
    const current = await ports.one(id);
    if (!current || !eligibleStage(current, categories) || catalogImageKey(current, index) !== key) throw missing();
    return result;
  }
  return { read, image };
}
