import { fields } from '../analysis/normalize';
import type { QuantityAreaStandard, QuantityPlanningConditions, QuantityPlanningSettings, QuantityPlanningSettingsSaveRequest, QuantityWorkSetting } from './contracts';
import { decimal as exactAmount } from './math';
import type { Decimal, ExpenseSetting, StorageMethod, WorkSetting } from './types';

export const MAX_SETTINGS_BYTES = 24 * 1024;
// Leaves room for the DynamoDB key, model metadata and other item attributes.
export const MAX_PLAN_BYTES = 320 * 1024;
export const MAX_REVISION = 2_147_483_647;
export const validRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_REVISION;
export const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value);
const settingId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value);
const label = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const method = (value: unknown): value is StorageMethod =>
  value === 'flat' || value === 'stack' || value === 'disassembled';
export const hasKeys = (row: Record<string, unknown>, fields: readonly string[], optional: readonly string[] = []) =>
  fields.every(key => Object.hasOwn(row, key)) && Object.keys(row).every(key => fields.includes(key) || optional.includes(key));
const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const boundedNumber = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
const decimal = (value: unknown): value is Decimal =>
  typeof value === 'number' && Number.isFinite(value) ||
  typeof value === 'string' && value.length <= 40 && /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d{1,3})?$/.test(value);
const boundedDecimal = (value: unknown, max: number): value is Decimal => {
  if (!decimal(value)) return false;
  const amount = exactAmount(value);
  return !!amount && amount.numerator >= 0n && amount.numerator <= BigInt(max) * amount.denominator;
};

export const DEFAULT_EXPENSES: ExpenseSetting[] = [
  { id: 'retail-fee', label: '通常販売手数料', channel: 'retail', basis: 'revenue-percent', value: null },
  { id: 'retail-shipping', label: '通常販売の自社負担送料', channel: 'retail', basis: 'per-unit', value: null },
  { id: 'wholesale-cost', label: '業販費用', channel: 'wholesale', basis: 'per-unit', value: null },
];
export const DEFAULT_WORK: WorkSetting[] = [
  { id: 'photography', label: '撮影', channel: 'retail', basis: 'once', minutes: null },
  { id: 'listing', label: '出品', channel: 'retail', basis: 'once', minutes: null },
  { id: 'packing', label: '梱包', channel: 'retail', basis: 'per-unit', minutes: null },
  { id: 'dispatch', label: '発送', channel: 'retail', basis: 'per-unit', minutes: null },
];
export const EMPTY_QUANTITY_SETTINGS: QuantityPlanningSettings = {
  flatAllowancePercent: 0, standards: [], expenses: DEFAULT_EXPENSES, remainingWork: DEFAULT_WORK,
};

export function parseConditions(input: unknown): QuantityPlanningConditions | null {
  const row = fields(input);
  if (!row || !hasKeys(row, ['saleMonths', 'saleCount', 'maintenanceMinutes', 'storageMethod', 'manualPlannedUnitPriceYen'])) return null;
  const { saleMonths, saleCount, maintenanceMinutes, storageMethod, manualPlannedUnitPriceYen } = row;
  if (!(saleMonths === null || decimal(saleMonths)) ||
      !(saleCount === null || typeof saleCount === 'number' && Number.isFinite(saleCount)) ||
      !(maintenanceMinutes === null || typeof maintenanceMinutes === 'number' && Number.isFinite(maintenanceMinutes)) ||
      !(storageMethod === null || method(storageMethod)) ||
      !(manualPlannedUnitPriceYen === null || decimal(manualPlannedUnitPriceYen))) return null;
  return { saleMonths, saleCount, maintenanceMinutes, storageMethod, manualPlannedUnitPriceYen };
}

function areaStandard(value: unknown): value is QuantityAreaStandard {
  const row = fields(value);
  return !!row && hasKeys(row, ['categoryId', 'method', 'source', 'areaM2PerBlock', 'unitsPerBlock', 'reference', 'disassemblyMinutes', 'reassemblyMinutes']) &&
    validId(row.categoryId) && method(row.method) &&
    (row.source === 'measured-category' || row.source === 'provisional-category') &&
    boundedNumber(row.areaM2PerBlock, 1_000_000) && row.areaM2PerBlock > 0 &&
    natural(row.unitsPerBlock) && row.unitsPerBlock > 0 && row.unitsPerBlock <= MAX_REVISION &&
    (row.method !== 'flat' || row.unitsPerBlock === 1) && label(row.reference, 160) &&
    [row.disassemblyMinutes, row.reassemblyMinutes].every(minutes =>
      minutes === null || row.method === 'disassembled' && boundedNumber(minutes, 100_000));
}

const channel = (value: unknown) => value === 'retail' || value === 'wholesale';
function expense(value: unknown): value is ExpenseSetting {
  const row = fields(value);
  return !!row && hasKeys(row, ['id', 'label', 'channel', 'basis', 'value']) &&
    settingId(row.id) && label(row.label, 80) && channel(row.channel) &&
    (row.basis === 'per-unit' || row.basis === 'once' || row.basis === 'revenue-percent') &&
    (row.value === null || boundedDecimal(row.value, row.basis === 'revenue-percent' ? 100 : 1_000_000_000)) &&
    (row.id !== 'retail-fee' && row.id !== 'retail-shipping' || row.channel === 'retail') &&
    (row.id !== 'wholesale-cost' || row.channel === 'wholesale');
}

function work(value: unknown): value is QuantityWorkSetting {
  const row = fields(value);
  return !!row && hasKeys(row, ['id', 'label', 'channel', 'basis', 'minutes'], ['includedInExpenseId']) &&
    settingId(row.id) && !['maintenance', 'disassembly-retail', 'disassembly-wholesale', 'reassembly'].includes(row.id) &&
    label(row.label, 80) && channel(row.channel) && (row.basis === 'per-unit' || row.basis === 'once') &&
    (row.minutes === null || boundedDecimal(row.minutes, 100_000)) &&
    (row.includedInExpenseId === undefined || settingId(row.includedInExpenseId)) &&
    (!DEFAULT_WORK.some(item => item.id === row.id) || row.channel === 'retail');
}

const unique = <T,>(items: readonly T[], key: (item: T) => string) => new Set(items.map(key)).size === items.length;
export function validateSettings(value: unknown): value is QuantityPlanningSettings {
  const row = fields(value);
  if (!row || !hasKeys(row, ['flatAllowancePercent', 'standards', 'expenses', 'remainingWork']) ||
      !boundedNumber(row.flatAllowancePercent, 1000)) return false;
  const { standards, expenses, remainingWork } = row;
  return Array.isArray(standards) && standards.length <= 300 && standards.every(areaStandard) &&
    unique(standards, item => [item.categoryId, item.method, item.source].join(':')) &&
    Array.isArray(expenses) && expenses.length <= 40 && expenses.every(expense) &&
    unique(expenses, item => item.channel + ':' + item.id) &&
    Array.isArray(remainingWork) && remainingWork.length <= 40 && remainingWork.every(work) &&
    unique(remainingWork, item => item.channel + ':' + item.id) &&
    remainingWork.every(item => item.includedInExpenseId === undefined ||
      [...expenses, ...DEFAULT_EXPENSES].some(expense => expense.channel === item.channel && expense.id === item.includedInExpenseId)) &&
    Buffer.byteLength(JSON.stringify(row)) <= MAX_SETTINGS_BYTES;
}

export function parseSettingsSave(value: unknown): QuantityPlanningSettingsSaveRequest | null {
  const row = fields(value);
  if (!row || !hasKeys(row, ['expectedRevision', 'settings'], ['expectedTaxonomyRevision']) ||
      !validRevision(row.expectedRevision) ||
      !(row.expectedTaxonomyRevision === undefined || validRevision(row.expectedTaxonomyRevision)) ||
      !validateSettings(row.settings)) return null;
  return { expectedRevision: row.expectedRevision, expectedTaxonomyRevision: row.expectedTaxonomyRevision, settings: row.settings };
}
