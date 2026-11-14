import type { Decimal, ExpenseSetting, QuantityPlanResult, StorageMethod, WorkSetting } from './types';

export type QuantityPlanningConditions = {
  saleMonths: Decimal | null;
  saleCount: number | null;
  maintenanceMinutes: number | null;
  storageMethod: StorageMethod | null;
  manualPlannedUnitPriceYen: Decimal | null;
};

export type QuantityPlanningSource = {
  inventoryId: string;
  title: string;
  categoryId: string | null;
  categoryName: string | null;
  workflowCategoryName: string | null;
  brand: string | null;
  quantity: number | null;
  purchaseUnitPriceYen: number | null;
  purchaseTotalYen: number | null;
  plannedUnitPriceYen: number | null;
  fingerprint: string;
};

export type QuantityAreaStandard = {
  categoryId: string;
  method: StorageMethod;
  source: 'measured-category' | 'provisional-category';
  areaM2PerBlock: number;
  unitsPerBlock: number;
  reference: string;
  disassemblyMinutes: number | null;
  reassemblyMinutes: number | null;
};

export type QuantityPlanningSettings = {
  flatAllowancePercent: number;
  standards: QuantityAreaStandard[];
  expenses: ExpenseSetting[];
  remainingWork: QuantityWorkSetting[];
};

export type QuantityWorkSetting = WorkSetting & { includedInExpenseId?: string };

export type SavedQuantityPlan = {
  inventoryId: string;
  revision: number;
  conditions: QuantityPlanningConditions;
  calculation: Extract<QuantityPlanResult, { ok: true }>;
  calculatedAt: string;
  calculatedBy: string;
  logicVersion: string;
  settingsVersion: number;
};

export type QuantityPlanningSaveRequest = {
  conditions: QuantityPlanningConditions;
  token: string;
  operationId: string;
};

export type QuantityPlanningSettingsSaveRequest = {
  expectedRevision: number;
  expectedTaxonomyRevision?: number;
  settings: QuantityPlanningSettings;
};

export type QuantityPlanningFailure = {
  status: 'forbidden' | 'not-found' | 'invalid' | 'conflict' | 'error';
  message: string;
};

export type QuantityPlanningReadResult = QuantityPlanningFailure | {
  status: 'ok';
  source: QuantityPlanningSource;
  latest: SavedQuantityPlan | null;
  stale: boolean;
  canEdit: boolean;
  logicVersion: string;
  settingsVersion: number;
};

export type QuantityPlanningCalculationResult = QuantityPlanningFailure | {
  status: 'ok';
  source: QuantityPlanningSource;
  calculation: QuantityPlanResult;
  token: string | null;
  logicVersion: string;
  settingsVersion: number;
};

export type QuantityPlanningSettingsResult = QuantityPlanningFailure | {
  status: 'ok';
  revision: number;
  taxonomyRevision: number;
  settings: QuantityPlanningSettings;
  categories: { id: string; label: string }[];
};

