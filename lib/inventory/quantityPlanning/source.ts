import { createHash } from 'node:crypto';
import { createAnalysisMetadataStore } from '../analysis/metadata';
import { nonnegative, text } from '../analysis/normalize';
import { UNKNOWN } from '../analysis/types';
import { parseCustomFields } from '../customFieldsCodecCore';
import type { QuantityPlanningConditions, QuantityPlanningSettings, QuantityPlanningSource, QuantityWorkSetting } from './contracts';
import { add, decimal, divide, multiply, ratio, type Rational } from './math';
import { DEFAULT_EXPENSES, DEFAULT_WORK } from './settings';
import type { AreaEvidence, ExpenseSetting, QuantityPlanInput, StorageMethod, WorkSetting } from './types';

export type QuantityClassification = Awaited<ReturnType<ReturnType<typeof createAnalysisMetadataStore>['quantityClassification']>>;
export type CategorySource = { id: string; name: string | null };
export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function registeredDimensionM(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 48) return null;
  const match = /^(\d{1,8}(?:\.\d{1,8})?|\.\d{1,8})\s*(mm|cm|m)?$/i.exec(value.normalize('NFKC').trim());
  if (!match) return null;
  const unitScale = { mm: 'e-3', cm: 'e-2', m: '' } as const;
  const unit = (match[2]?.toLowerCase() ?? 'cm') as keyof typeof unitScale;
  const meters = match[1] + unitScale[unit];
  return Number(meters) > 0 ? meters : null;
}

export function sourceFromInventory(row: Record<string, unknown>, classification: QuantityClassification, workflow: CategorySource[]) {
  const inventory = classification.inventory;
  const category = inventory?.categoryState === 'confirmed' ? inventory.categoryId : classification.kind?.categoryId;
  const categoryId = classification.taxonomy.canonical(category);
  const categoryName = classification.taxonomy.categories.find(item => item.id === categoryId)?.label ?? null;
  const quantity = nonnegative(row.quantity);
  const purchaseUnitPriceYen = nonnegative(row.purchasePrice);
  const plannedUnitPriceYen = nonnegative(row.plannedSalePrice);
  const total = quantity === null || purchaseUnitPriceYen === null ? null : quantity * purchaseUnitPriceYen;
  const purchaseTotalYen = Number.isSafeInteger(total) ? total : null;
  const brand = text(parseCustomFields(row.customFields)?.belloBrand) ??
    text(classification.kind?.specification.brand);
  const base = {
    inventoryId: String(row.id),
    title: typeof row.name === 'string' ? row.name.slice(0, 2000) : '',
    categoryId: categoryId === UNKNOWN ? null : categoryId,
    categoryName,
    workflowCategoryName: workflow.map(item => item.name).filter(Boolean).join('、') || null,
    brand,
    quantity,
    purchaseUnitPriceYen,
    purchaseTotalYen,
    plannedUnitPriceYen,
  };
  const source: QuantityPlanningSource = {
    ...base,
    fingerprint: fingerprint([base, row.updatedAt, row.revision, row.width, row.depth, row.saleEndDate, row.externalProductId, classification.versions, workflow]),
  };
  return { source, row, workflow };
}

export type InventoryQuantitySource = ReturnType<typeof sourceFromInventory>;

function mergeById<T extends { id: string; channel: string }>(defaults: T[], settings: T[]): T[] {
  const items = new Map(defaults.map(item => [item.channel + ':' + item.id, item]));
  for (const item of settings) items.set(item.channel + ':' + item.id, item);
  return [...items.values()];
}

// Inputs here are terminating decimals, including allowance percentage points.
function exactDecimal({ numerator, denominator }: Rational): string {
  let scaled = numerator;
  let places = 0;
  while (scaled % denominator !== 0n) {
    scaled *= 10n;
    places++;
  }
  return (scaled / denominator).toString() + (places ? 'e-' + places : '');
}

function resolveArea(source: InventoryQuantitySource, method: StorageMethod | null, settings: QuantityPlanningSettings) {
  if (!method) return { area: null, standard: null };
  const { row } = source;
  const multiplier = method === 'flat'
    ? add(ratio(1n), divide(decimal(settings.flatAllowancePercent)!, ratio(100n)))
    : ratio(1n);
  if (method === 'flat') {
    const width = registeredDimensionM(row.width);
    const depth = registeredDimensionM(row.depth);
    if (width !== null && depth !== null) {
      const area: AreaEvidence = {
        method, source: 'inventory', areaM2PerBlock: exactDecimal(multiply(multiply(decimal(width)!, decimal(depth)!), multiplier)), unitsPerBlock: 1,
        reference: `登録寸法 幅 ${Number(width)} m × 奥行 ${Number(depth)} m${settings.flatAllowancePercent ? `、共通余白 ${settings.flatAllowancePercent}%` : ''}`,
      };
      return { area, standard: null };
    }
  }
  const candidates = settings.standards.filter(item => item.method === method && item.categoryId === source.source.categoryId);
  const standard = candidates.find(item => item.source === 'measured-category') ??
    candidates.find(item => item.source === 'provisional-category') ?? null;
  if (!standard) return { area: null, standard: null };
  const area: AreaEvidence = {
    method, source: standard.source, areaM2PerBlock: exactDecimal(multiply(decimal(standard.areaM2PerBlock)!, multiplier)),
    unitsPerBlock: standard.unitsPerBlock,
    reference: `${source.source.categoryName ?? standard.categoryId}・${standard.reference}${method === 'flat' && settings.flatAllowancePercent ? `、共通余白 ${settings.flatAllowancePercent}%` : ''}`,
  };
  return { area, standard };
}

const pendingPhotography = new Set(['撮影待ち']);
const pendingListing = new Set(['撮影待ち', '出品待ち', '複数在庫未出品']);
const listed = new Set(['販売中', '出品中']);
const closed = new Set(['売り切れ', '発送完了', '出荷指示済', '出荷指示済み', '発送済み', '入金待ち', '未入金', '破棄', '廃棄', '無償提供']);

function remainingWork(source: InventoryQuantitySource, settings: QuantityPlanningSettings, expenses: ExpenseSetting[]): WorkSetting[] {
  const names = source.workflow.map(item => item.name?.replace(/\s/g, '') ?? '');
  const hasClosedWorkflow = names.some(name => closed.has(name)) || Boolean(source.row.saleEndDate);
  const hasExistingListing = names.some(name => listed.has(name)) || Boolean(source.row.externalProductId);
  const hasOpenWorkflow = names.some(name => pendingListing.has(name) || listed.has(name));
  const work: WorkSetting[] = [];
  for (const { includedInExpenseId, ...item } of mergeById<QuantityWorkSetting>(DEFAULT_WORK, settings.remainingWork)) {
    if (includedInExpenseId && expenses.some(fee => fee.id === includedInExpenseId && fee.channel === item.channel && fee.value !== null)) continue;
    if (hasClosedWorkflow) {
      if (DEFAULT_WORK.some(defaultItem => defaultItem.id === item.id)) continue;
    }
    if ((item.id === 'photography' || item.id === 'listing') && hasExistingListing) continue;
    if (item.id === 'photography' && !names.some(name => pendingPhotography.has(name))) item.minutes = null;
    if (item.id === 'listing' && !names.some(name => pendingListing.has(name))) item.minutes = null;
    // A sale-stage category alone cannot certify that physical packing is still needed.
    if (item.id === 'packing' || (item.id === 'dispatch' && !hasOpenWorkflow)) item.minutes = null;
    work.push(item);
  }
  return work;
}

export function authoritativeInput(source: InventoryQuantitySource, conditions: QuantityPlanningConditions, settings: QuantityPlanningSettings): QuantityPlanInput {
  const { area, standard } = resolveArea(source, conditions.storageMethod, settings);
  const expenses = mergeById(DEFAULT_EXPENSES, settings.expenses);
  const work = remainingWork(source, settings, expenses);
  if (conditions.storageMethod === 'disassembled') {
    work.push(
      { id: 'disassembly-retail', label: '分解（通常販売分）', channel: 'retail', basis: 'per-unit', minutes: standard?.disassemblyMinutes ?? null },
      { id: 'disassembly-wholesale', label: '分解（業販分）', channel: 'wholesale', basis: 'per-unit', minutes: standard?.disassemblyMinutes ?? null },
      { id: 'reassembly', label: '再組立（通常販売分）', channel: 'retail', basis: 'per-unit', minutes: standard?.reassemblyMinutes ?? null },
    );
  }
  const { quantity, purchaseUnitPriceYen, plannedUnitPriceYen } = source.source;
  return {
    quantity, purchaseUnitPriceYen,
    plannedUnitPriceYen: plannedUnitPriceYen ?? conditions.manualPlannedUnitPriceYen,
    plannedPriceSource: plannedUnitPriceYen === null ? 'manual' : 'registered',
    saleMonths: conditions.saleMonths, saleCount: conditions.saleCount, maintenanceMinutes: conditions.maintenanceMinutes,
    storageMethod: conditions.storageMethod, area, expenses, remainingWork: work,
  };
}
