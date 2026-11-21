/** Public DTOs only. Never serialize an inventory row or a stored grant. */
export type CatalogStage = 'repair' | 'photo' | 'listing';
export interface PublicCatalogItem {
  id: string;
  name: string;
  managementNumber: string;
  quantity: number;
  dimensions: { width: string | null; depth: string | null; height: string | null };
  stage: CatalogStage;
  stageLabel: '補修待ち' | '撮影待ち' | '出品待ち';
  imageUrl: string | null;
  images: string[];
}
export interface PublicCatalogResponse {
  ok: true;
  title: string;
  updatedAt: string;
  checkedAt: string;
  expiresAt: string;
  items: PublicCatalogItem[];
}
export const MAX_CATALOG_SELECTED_ITEMS = 500;

/** ADMIN-only response: path contains the bearer capability. */
export interface CatalogGrant {
  id: string;
  label: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disabled: boolean;
  path: string;
  revision: number;
  selectedIds: string[];
}
export interface CatalogManagementResponse { ok: true; grants: CatalogGrant[] }

export interface CatalogSelectionResponse {
  ok: true; grant: CatalogGrant; candidates: PublicCatalogItem[]; maxSelectedItems: number; checkedAt: string;
}
export interface CatalogSelectionSave { id: string; revision: number; selectedIds: string[] }
