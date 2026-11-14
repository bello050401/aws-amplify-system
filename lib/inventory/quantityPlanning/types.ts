export type Decimal = number | string;

export type StorageMethod = "flat" | "stack" | "disassembled";
export type AreaSource = "inventory" | "measured-category" | "provisional-category";
export type SalesChannel = "retail" | "wholesale";

export type AreaEvidence = {
  method: StorageMethod;
  source: AreaSource;
  areaM2PerBlock: Decimal;
  unitsPerBlock: number;
  reference?: string;
};

export type ExpenseSetting = {
  id: string;
  label: string;
  channel: SalesChannel;
  basis: "per-unit" | "once" | "revenue-percent";
  /** Yen or percentage points, depending on basis. Null indicates an unpriced expense. */
  value: Decimal | null;
};

export type WorkSetting = {
  id: string;
  label: string;
  channel: SalesChannel;
  basis: "per-unit" | "once";
  /** Future minutes only. Null indicates work for which no time is available. */
  minutes: Decimal | null;
};

export type QuantityPlanInput = {
  quantity: number | null;
  purchaseUnitPriceYen: Decimal | null;
  plannedUnitPriceYen: Decimal | null;
  plannedPriceSource: "registered" | "manual";
  saleMonths: Decimal | null;
  saleCount: number | null;
  maintenanceMinutes: number | null;
  storageMethod: StorageMethod | null;
  area: AreaEvidence | null;
  expenses: ExpenseSetting[];
  remainingWork: WorkSetting[];
};

export type QuantityPlanInputs = {
  [Key in keyof QuantityPlanInput]: NonNullable<QuantityPlanInput[Key]>;
};

export type QuantityPlanIssue = {
  field: keyof QuantityPlanInput | "calculation";
  reason: "missing" | "invalid" | "out-of-range";
};

export const QUANTITY_PLAN_RULES = {
  wholesaleAfterDays: 14,
  daysPerMonth: 30,
  laborYenPerHour: 2_000,
  storageYenPerTsuboMonth: 5_500,
  squareMetersPerTsubo: 3.305785,
} as const;

export type ExpenseItem = ExpenseSetting & {
  status: "counted" | "not-applicable" | "unpriced";
  costYen: number | null;
};

export type WorkItem = WorkSetting & {
  status: "counted" | "not-applicable" | "unpriced";
  totalMinutes: number | null;
  costYen: number | null;
};

export type QuantityPlanCandidate = {
  retailQuantity: number;
  wholesaleQuantity: number;
  retailSelloutMonths: number;
  clearanceMonths: number;
  retailGrossYen: number;
  wholesaleGrossYen: number;
  retailNetYen: number;
  wholesaleNetYen: number;
  workMinutes: number;
  workCostYen: number;
  storageCostYen: number;
  maxAreaM2: number;
  maxAreaTsubo: number;
  recoveryYen: number;
  afterPurchaseCostYen: number;
  expenseItems: ExpenseItem[];
  workItems: WorkItem[];
};

export type QuantityPlanScenario = {
  retailUnitsPerMonth: number;
  saleIntervalMonths: number;
  recommended: QuantityPlanCandidate;
  allRetail: QuantityPlanCandidate;
  differenceYen: number;
};

export type QuantityPlan = QuantityPlanScenario & {
  logicVersion: string;
  rules: typeof QUANTITY_PLAN_RULES;
  inputs: QuantityPlanInputs;
  purchaseTotalYen: number;
  halfPace: QuantityPlanScenario;
};

export type QuantityPlanResult =
  | { ok: true; plan: QuantityPlan }
  | { ok: false; issues: QuantityPlanIssue[] };
