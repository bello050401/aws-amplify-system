import type { InventoryRole } from '../../amplify/requireInventoryUser';
import { fields } from '../analysis/normalize';
import type { QuantityPlanningCalculationResult, QuantityPlanningConditions, QuantityPlanningFailure,
  QuantityPlanningReadResult, QuantityPlanningSettingsResult } from './contracts';
import { calculateQuantityPlan, QUANTITY_PLAN_LOGIC_VERSION } from './engine';
import { MAX_PLAN_BYTES, MAX_REVISION, hasKeys, parseConditions, parseSettingsSave, validId, validRevision } from './settings';
import { authoritativeInput, fingerprint } from './source';
import { isWriteConflict, type QuantityPlanningStore, type StoredQuantityPlan } from './store';

export type QuantityPlanningAccess = { owner: string; role: InventoryRole };
type Store = QuantityPlanningStore;
type Token = {
  source: string;
  settings: number;
  plan: number;
  logic: string;
  conditions: string;
  result: string;
};

const FORBIDDEN = { status: 'forbidden', message: '操作権限を確認してください。' } as const;
const INVALID = { status: 'invalid', message: '入力内容を確認してください。' } as const;
const NOT_FOUND = { status: 'not-found', message: '在庫が見つかりません。' } as const;
const CONFLICT = { status: 'conflict', message: '最新の在庫・設定・保存結果を確認し、再計算してください。' } as const;
const ERROR = { status: 'error', message: 'データを確認できませんでした。しばらくしてから再試行してください。' } as const;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RESULT_BYTES = MAX_PLAN_BYTES - 4096; // Storage envelope reserves bounded id, actor, conditions and versions.

function tokenFrom(raw: unknown): Token | null {
  if (typeof raw !== 'string' || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const token = fields(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    if (!token || !hasKeys(token, ['source', 'settings', 'plan', 'logic', 'conditions', 'result']) ||
        ![token.source, token.conditions, token.result].every(value => typeof value === 'string' && HASH.test(value)) ||
        !validRevision(token.settings) || !validRevision(token.plan) || typeof token.logic !== 'string' || token.logic.length > 40) return null;
    return { source: token.source as string, settings: token.settings, plan: token.plan, logic: token.logic,
      conditions: token.conditions as string, result: token.result as string };
  } catch { return null; }
}

function saveRequest(raw: unknown) {
  const row = fields(raw);
  if (!row || !hasKeys(row, ['conditions', 'token', 'operationId']) || typeof row.operationId !== 'string') return null;
  const operationId = row.operationId.toLowerCase();
  const conditions = parseConditions(row.conditions);
  const token = tokenFrom(row.token);
  if (!UUID.test(operationId) || !conditions || !token) return null;
  return { operationId, conditions, token };
}

function normalizedConditions(conditions: QuantityPlanningConditions, registeredPrice: number | null) {
  return registeredPrice === null ? conditions : { ...conditions, manualPlannedUnitPriceYen: null };
}

export function createQuantityPlanningService(deps: {
  authorize: () => Promise<QuantityPlanningAccess | null>;
  canEdit: (role: InventoryRole) => boolean;
  store: Store;
  now?: () => string;
}) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const load = async (id: string) => {
    const [source, settings, saved] = await Promise.all([store.readSource(id), store.getSettings(), store.getPlan(id)]);
    return { source, settings, saved };
  };

  function asRead(data: Awaited<ReturnType<typeof load>>, access: QuantityPlanningAccess): QuantityPlanningReadResult {
    if (!data.source) return NOT_FOUND;
    const { source } = data.source;
    const { revision: settingsVersion } = data.settings;
    const latest = data.saved?.plan ?? null;
    const stale = !!latest && (data.saved?.sourceFingerprint !== source.fingerprint ||
      latest.settingsVersion !== settingsVersion || latest.logicVersion !== QUANTITY_PLAN_LOGIC_VERSION);
    return { status: 'ok', source, latest, stale, canEdit: deps.canEdit(access.role),
      settingsVersion, logicVersion: QUANTITY_PLAN_LOGIC_VERSION };
  }

  async function read(id: unknown): Promise<QuantityPlanningReadResult> {
    try {
      const access = await deps.authorize();
      if (!access?.owner) return FORBIDDEN;
      if (!validId(id)) return INVALID;
      return asRead(await load(id), access);
    } catch { return ERROR; }
  }

  async function calculate(id: unknown, raw: unknown): Promise<QuantityPlanningCalculationResult> {
    try {
      const access = await deps.authorize();
      if (!access?.owner) return FORBIDDEN;
      const incoming = parseConditions(raw);
      if (!validId(id) || !incoming) return INVALID;
      const { source, settings, saved } = await load(id);
      if (!source) return NOT_FOUND;
      const conditions = normalizedConditions(incoming, source.source.plannedUnitPriceYen);
      const computed = calculateQuantityPlan(authoritativeInput(source, conditions, settings.settings));
      const calculation = computed.ok && Buffer.byteLength(JSON.stringify(computed)) > RESULT_BYTES
        ? { ok: false as const, issues: [{ field: 'calculation' as const, reason: 'out-of-range' as const }] }
        : computed;
      const token = calculation.ok && deps.canEdit(access.role) ? Buffer.from(JSON.stringify({
        source: source.source.fingerprint,
        settings: settings.revision,
        plan: saved?.plan.revision ?? 0,
        logic: QUANTITY_PLAN_LOGIC_VERSION,
        conditions: fingerprint(incoming),
        result: fingerprint(calculation),
      } satisfies Token)).toString('base64url') : null;
      return { status: 'ok', source: source.source, calculation, token, settingsVersion: settings.revision,
        logicVersion: QUANTITY_PLAN_LOGIC_VERSION };
    } catch { return ERROR; }
  }

  async function save(id: unknown, raw: unknown, permitWrite = true): Promise<QuantityPlanningReadResult> {
    try {
      const access = await deps.authorize();
      if (!access?.owner || !deps.canEdit(access.role) || !permitWrite) return FORBIDDEN;
      const request = saveRequest(raw);
      if (!validId(id) || !request) return INVALID;
      const { operationId, token, conditions: incoming } = request;
      const conditionsHash = fingerprint(incoming);
      if (token.conditions !== conditionsHash) return CONFLICT;
      const requestHash = fingerprint([access.owner, id, token, incoming]);
      const confirmed = (receipt: NonNullable<Awaited<ReturnType<Store['getReceipt']>>>) =>
        receipt.requestHash === requestHash && receipt.revision === token.plan + 1;
      const receipt = await store.getReceipt(id, operationId);
      if (receipt) return confirmed(receipt) ? asRead(await load(id), access) : CONFLICT;

      const data = await load(id);
      if (!data.source) return NOT_FOUND;
      const source = data.source;
      if (token.logic !== QUANTITY_PLAN_LOGIC_VERSION || token.settings !== data.settings.revision ||
          token.source !== source.source.fingerprint || token.plan !== (data.saved?.plan.revision ?? 0) ||
          token.plan === MAX_REVISION) return CONFLICT;
      const conditions = normalizedConditions(incoming, source.source.plannedUnitPriceYen);
      const calculation = calculateQuantityPlan(authoritativeInput(source, conditions, data.settings.settings));
      if (!calculation.ok || Buffer.byteLength(JSON.stringify(calculation)) > RESULT_BYTES ||
          fingerprint(calculation) !== token.result) return CONFLICT;
      const value: StoredQuantityPlan = {
        inventoryId: id, revision: token.plan + 1, conditions, calculation,
        calculatedAt: now(), calculatedBy: access.owner,
        logicVersion: QUANTITY_PLAN_LOGIC_VERSION, settingsVersion: data.settings.revision,
        sourceFingerprint: source.source.fingerprint,
      };
      try {
        await store.putPlan({ value, operationId, requestHash, before: data.saved?.plan ?? null, source: data.source });
      } catch (error) {
        // DDB may commit while the HTTP response is lost, or another retry may win.
        const replay = await store.getReceipt(id, operationId);
        if (replay) return confirmed(replay) ? asRead(await load(id), access) : CONFLICT;
        return isWriteConflict(error) ? CONFLICT : ERROR;
      }
      return asRead(await load(id), access);
    } catch { return ERROR; }
  }

  async function settingsResponse(): Promise<QuantityPlanningSettingsResult> {
    const [current, taxonomy] = await Promise.all([store.getSettings(), store.classification()]);
    return { status: 'ok', ...current, categories: taxonomy.taxonomy.categories, taxonomyRevision: taxonomy.versions[0].revision };
  }

  async function readSettings(): Promise<QuantityPlanningSettingsResult> {
    try {
      const access = await deps.authorize();
      return access?.owner && access.role === 'ADMIN' ? await settingsResponse() : FORBIDDEN;
    } catch { return ERROR; }
  }

  async function saveSettings(raw: unknown): Promise<QuantityPlanningSettingsResult> {
    try {
      const access = await deps.authorize();
      if (!access?.owner || access.role !== 'ADMIN') return FORBIDDEN;
      const request = parseSettingsSave(raw);
      if (!request || request.expectedRevision === MAX_REVISION) return INVALID;
      const taxonomy = await store.classification();
      if (request.expectedTaxonomyRevision !== undefined && request.expectedTaxonomyRevision !== taxonomy.versions[0].revision) {
        return { status: 'conflict', message: '商品分類が更新されています。設定を再読み込みしてください。' } satisfies QuantityPlanningFailure;
      }
      const allowed = new Set(taxonomy.taxonomy.categories.map(item => item.id));
      if (request.settings.standards.some(item => !allowed.has(item.categoryId))) return INVALID;
      try {
        await store.putSettings(request.settings, request.expectedRevision, taxonomy.versions[0], access.owner, now());
      } catch (error) {
        if (isWriteConflict(error)) return { status: 'conflict', message: '設定が更新されています。再読み込みしてください。' };
        throw error;
      }
      return await settingsResponse();
    } catch { return ERROR; }
  }

  return { read, calculate, save, readSettings, saveSettings };
}
