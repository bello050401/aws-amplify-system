import 'server-only';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { GetCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { validToken, type Row } from './policy';
import type { CatalogGrant } from './types';

type Db = Pick<DynamoDBDocumentClient, 'send'>;
const SCOPE = 'control'; // Already permitted by InventoryAnalysisMetadata's LeadingKeys IAM condition.
const GRANT_PREFIX = 'partner-catalog:grant:';
const TOKEN_PREFIX = 'partner-catalog:token:';
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const label = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
export class CatalogError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface StoredGrant {
  grantId: string; token: string; tokenHash: string; label: string; title: string;
  createdAt: string; updatedAt: string; expiresAt: string; disabled: boolean; revision: number; changedBy: string;
}
function parseGrant(item: Row | undefined): StoredGrant | null {
  if (!item || !uuid(item.grantId) || !validToken(item.token) || item.tokenHash !== hash(item.token)
      || !label(item.label, 80) || !label(item.title, 120) || typeof item.disabled !== 'boolean'
      || typeof item.revision !== 'number' || !Number.isSafeInteger(item.revision) || item.revision < 1
      || !['createdAt', 'updatedAt', 'expiresAt'].every(key => typeof item[key] === 'string' && Number.isFinite(Date.parse(item[key] as string)))
      || item.scope !== SCOPE || item.id !== GRANT_PREFIX + item.grantId) return null;
  return item as unknown as StoredGrant;
}
export function publicGrant(grant: StoredGrant): CatalogGrant {
  return { id: grant.grantId, label: grant.label, title: grant.title, createdAt: grant.createdAt,
    updatedAt: grant.updatedAt, expiresAt: grant.expiresAt, disabled: grant.disabled, path: `/share/inventory/${grant.token}` };
}

export function createCatalogGrantStore(db: Db, table: string, now = () => Date.now()) {
  const get = async (id: string) => (await db.send(new GetCommand({ TableName: table, Key: { scope: SCOPE, id }, ConsistentRead: true }))).Item;
  const key = (id: string) => ({ scope: SCOPE, id });
  const item = (grant: StoredGrant) => ({ ...grant, ...key(GRANT_PREFIX + grant.grantId), __typename: 'InventoryAnalysisMetadata' });
  const lookup = (grant: StoredGrant) => ({ ...key(TOKEN_PREFIX + grant.tokenHash), grantId: grant.grantId, tokenHash: grant.tokenHash, revision: grant.revision,
    createdAt: grant.updatedAt, updatedAt: grant.updatedAt, __typename: 'InventoryAnalysisMetadata' });

  async function authorize(token: string): Promise<StoredGrant | null> {
    if (!validToken(token)) return null;
    const tokenHash = hash(token);
    const reference = await get(TOKEN_PREFIX + tokenHash);
    if (!reference || reference.tokenHash !== tokenHash || !uuid(reference.grantId)) return null;
    const grant = parseGrant(await get(GRANT_PREFIX + reference.grantId));
    return grant && !grant.disabled && grant.tokenHash === tokenHash && Date.parse(grant.expiresAt) > now() ? grant : null;
  }

  async function list(): Promise<CatalogGrant[]> {
    const response = await db.send(new QueryCommand({ TableName: table, ConsistentRead: true, Limit: 101,
      KeyConditionExpression: '#scope = :scope AND begins_with(id, :prefix)',
      ExpressionAttributeNames: { '#scope': 'scope' }, ExpressionAttributeValues: { ':scope': SCOPE, ':prefix': GRANT_PREFIX } }));
    if (response.LastEvaluatedKey || (response.Items?.length ?? 0) > 100) throw new CatalogError(503, '共有リンク一覧を読み込めません。');
    return (response.Items ?? []).map(value => {
      const grant = parseGrant(value);
      if (!grant) throw new CatalogError(503, '共有リンク一覧を読み込めません。');
      return publicGrant(grant);
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function manage(raw: unknown, actor: string): Promise<CatalogGrant> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !actor) throw new CatalogError(400, '入力内容を確認してください。');
    const input = raw as Row;
    const action = input.action;
    const allowed = action === 'create' ? ['action', 'label', 'title', 'expiresInDays'] : action === 'renew' ? ['action', 'id', 'expiresInDays'] : ['action', 'id'];
    if (!['create', 'renew', 'disable'].includes(String(action)) || Object.keys(input).some(key => !allowed.includes(key))) throw new CatalogError(400, '入力内容を確認してください。');
    const days = input.expiresInDays === undefined ? 90 : input.expiresInDays;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) throw new CatalogError(400, '有効期間は1〜365日で指定してください。');
    const timestamp = new Date(now()).toISOString();
    let before: StoredGrant | null = null;
    let after: StoredGrant;
    if (action === 'create') {
      if ((input.label !== undefined && !label(input.label, 80)) || (input.title !== undefined && !label(input.title, 120))) throw new CatalogError(400, 'リンク名とタイトルを確認してください。');
      if ((await list()).length >= 100) throw new CatalogError(400, '共有リンクは100件まで作成できます。');
      const token = randomBytes(32).toString('base64url');
      after = { grantId: randomUUID(), token, tokenHash: hash(token), label: String(input.label ?? '取引先共有').trim(),
        title: String(input.title ?? 'BELLO 商品カタログ').trim(), createdAt: timestamp, updatedAt: timestamp,
        expiresAt: new Date(now() + days * 86400000).toISOString(), disabled: false, revision: 1, changedBy: actor };
    } else {
      if (!uuid(input.id)) throw new CatalogError(400, '共有リンクを選び直してください。');
      before = parseGrant(await get(GRANT_PREFIX + input.id));
      if (!before) throw new CatalogError(404, '共有リンクが見つかりません。');
      after = { ...before, updatedAt: timestamp, revision: before.revision + 1, changedBy: actor };
      if (action === 'disable') after.disabled = true;
      else {
        after.token = randomBytes(32).toString('base64url');
        after.tokenHash = hash(after.token);
        after.expiresAt = new Date(now() + days * 86400000).toISOString();
        after.disabled = false;
      }
    }
    const writes: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> = [{ Put: {
      TableName: table, Item: item(after), ConditionExpression: before ? 'revision = :revision' : 'attribute_not_exists(id)',
      ...(before ? { ExpressionAttributeValues: { ':revision': before.revision } } : {}),
    } }];
    // The deployed metadata IAM permits Get/Query/Put only. Old lookups are
    // inert tombstones; binding to the current grant hash independently rejects them.
    if (before) writes.push({ Put: { TableName: table, Item: { ...key(TOKEN_PREFIX + before.tokenHash),
      disabled: true, revision: after.revision, updatedAt: timestamp, __typename: 'InventoryAnalysisMetadata' } } });
    if (!after.disabled) writes.push({ Put: { TableName: table, Item: lookup(after), ConditionExpression: 'attribute_not_exists(id)' } });
    try { await db.send(new TransactWriteCommand({ TransactItems: writes })); }
    catch (error) {
      if (error instanceof Error && error.name === 'TransactionCanceledException') throw new CatalogError(409, '別の操作で更新されました。再読み込みしてください。');
      throw error;
    }
    return publicGrant(after);
  }
  return { authorize, list, manage };
}
