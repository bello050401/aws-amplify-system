import 'server-only';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import outputs from '../../../amplify_outputs.json';
import { getVerifiedInventoryAccess } from '@/lib/amplify/requireInventoryUser';
import { inventoryVerifiedReadSession } from '../mutationSession';
import { inventoryDdb, inventoryTable } from '../categoryPersistence';
import { CatalogError, createCatalogGrantStore } from './grants';
import { createCatalogReader } from './reader';
import { createPartnerCatalogService } from './service';
import { validStorageKey } from './policy';

const reader = createCatalogReader(inventoryDdb, inventoryTable);
const s3 = new S3Client({ region: outputs.storage.aws_region });
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const partnerCatalogResponseHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow, noarchive, noimageindex', 'X-Content-Type-Options': 'nosniff',
};

/** Both the UI role decision and the separately signature-verified identity must agree. */
export async function requireCatalogAdmin(): Promise<{ owner: string }> {
  const access = await getVerifiedInventoryAccess();
  if (access.kind === 'temporarily-unavailable') throw new CatalogError(503, '認証を確認できません。再試行してください。');
  if (access.kind !== 'authorized') throw new CatalogError(access.kind === 'signed-out' ? 401 : 403, '管理者としてログインしてください。');
  if (access.role !== 'ADMIN' || !access.owner) throw new CatalogError(403, '管理者のみ利用できます。');
  const session = await inventoryVerifiedReadSession();
  if (!session || session.role !== 'ADMIN' || session.owner !== access.owner) throw new CatalogError(403, '管理者の認証を確認できません。');
  return { owner: session.owner };
}
export const catalogGrantStore = () => createCatalogGrantStore(inventoryDdb, inventoryTable('InventoryAnalysisMetadata'));

async function readPhoto(key: string) {
  if (!validStorageKey(key)) throw new CatalogError(404, '画像を表示できません。');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: outputs.storage.bucket_name, Key: key }), { abortSignal: controller.signal });
    const contentType = object.ContentType?.split(';')[0].trim().toLowerCase();
    if (!object.Body || !contentType || !IMAGE_MIMES.has(contentType) || typeof object.ContentLength !== 'number'
        || object.ContentLength < 1 || object.ContentLength > MAX_IMAGE_BYTES) throw new CatalogError(404, '画像を表示できません。');
    const bytes = await object.Body.transformToByteArray();
    if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) throw new CatalogError(404, '画像を表示できません。');
    return { bytes, contentType };
  } finally { clearTimeout(timeout); }
}
export function partnerCatalogServer() {
  const grants = catalogGrantStore();
  return createPartnerCatalogService({ authorize: grants.authorize, ...reader, image: readPhoto });
}
export function catalogFailure(error: unknown): { status: number; error: string } {
  return error instanceof CatalogError ? { status: error.status, error: error.message }
    : { status: 503, error: '情報を読み込めません。しばらくしてから再試行してください。' };
}
