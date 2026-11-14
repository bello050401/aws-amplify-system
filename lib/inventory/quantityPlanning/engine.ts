import {
  add,
  blockCount,
  CalculationOutOfRange,
  commonDenominator,
  decimal,
  divide,
  multiply,
  ratio,
  scale,
  storageBlockTicks,
  subtract,
  toNumber,
  ZERO,
  type Rational,
} from "./math";
import {
  QUANTITY_PLAN_RULES,
  type AreaEvidence,
  type ExpenseItem,
  type ExpenseSetting,
  type QuantityPlanCandidate,
  type QuantityPlanInput,
  type QuantityPlanInputs,
  type QuantityPlanIssue,
  type QuantityPlanResult,
  type QuantityPlanScenario,
  type SalesChannel,
  type StorageMethod,
  type WorkItem,
  type WorkSetting,
} from "./types";

export const QUANTITY_PLAN_LOGIC_VERSION = "1";
/** Bounds synchronous work per calculation request. */
export const MAX_QUANTITY_PLAN_STOCK = 100_000;

const wholesaleMonths = ratio(
  BigInt(QUANTITY_PLAN_RULES.wholesaleAfterDays),
  BigInt(QUANTITY_PLAN_RULES.daysPerMonth),
);
const laborPerMinute = ratio(BigInt(QUANTITY_PLAN_RULES.laborYenPerHour), 60n);
const squareMetersPerTsubo = decimal(QUANTITY_PLAN_RULES.squareMetersPerTsubo)!;
const storagePerTsuboMonth = ratio(BigInt(QUANTITY_PLAN_RULES.storageYenPerTsuboMonth));
const storageMethods = new Set<StorageMethod>(["flat", "stack", "disassembled"]);
const areaSources = new Set<AreaEvidence["source"]>(["inventory", "measured-category", "provisional-category"]);

type ExpenseRate = { setting: ExpenseSetting; costYen: Rational | null };
type WorkRate = { setting: WorkSetting; minutes: Rational | null };

function parseDecimalField(
  value: unknown,
  field: QuantityPlanIssue["field"],
  issues: QuantityPlanIssue[],
  positive = false,
): Rational | null {
  if (value == null || (typeof value === "string" && value.trim() === "")) {
    issues.push({ field, reason: "missing" });
    return null;
  }
  const parsed = decimal(value);
  if (!parsed || parsed.numerator < 0n || (positive && parsed.numerator === 0n)) {
    issues.push({ field, reason: "invalid" });
    return null;
  }
  return parsed;
}

function validSettings<Item extends ExpenseSetting | WorkSetting>(
  items: Item[],
  validItem: (item: Item) => boolean,
): boolean {
  if (!Array.isArray(items)) return false;
  const keys = new Set<string>();
  for (const item of items) {
    if (item == null || typeof item.id !== "string" || item.id.trim() === ""
      || typeof item.label !== "string" || item.label.trim() === ""
      || (item.channel !== "retail" && item.channel !== "wholesale") || !validItem(item)) return false;
    const key = `${item.channel}:${item.id}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

function isNonnegativeOrUnpriced(value: ExpenseSetting["value"]): boolean {
  return value === null || (decimal(value)?.numerator ?? -1n) >= 0n;
}

function validArea(area: AreaEvidence, method: StorageMethod | null): boolean {
  return area.method === method && areaSources.has(area.source)
    && (decimal(area.areaM2PerBlock)?.numerator ?? 0n) > 0n
    && Number.isSafeInteger(area.unitsPerBlock) && area.unitsPerBlock > 0
    && (method !== "flat" || area.unitsPerBlock === 1)
    && (area.reference === undefined || typeof area.reference === "string");
}

function validateInput(
  input: QuantityPlanInput,
  issues: QuantityPlanIssue[],
): { purchasePrice: Rational | null; plannedPrice: Rational | null; saleMonths: Rational | null } {
  if (input.quantity == null) {
    issues.push({ field: "quantity", reason: "missing" });
  } else if (!Number.isSafeInteger(input.quantity) || input.quantity < 0) {
    issues.push({ field: "quantity", reason: "invalid" });
  } else if (input.quantity > MAX_QUANTITY_PLAN_STOCK) {
    issues.push({ field: "quantity", reason: "out-of-range" });
  }
  const purchasePrice = parseDecimalField(input.purchaseUnitPriceYen, "purchaseUnitPriceYen", issues);
  const plannedPrice = parseDecimalField(input.plannedUnitPriceYen, "plannedUnitPriceYen", issues);
  if (input.plannedPriceSource !== "registered" && input.plannedPriceSource !== "manual") {
    issues.push({ field: "plannedPriceSource", reason: "invalid" });
  }
  const saleMonths = parseDecimalField(input.saleMonths, "saleMonths", issues, true);
  if (input.saleCount == null) {
    issues.push({ field: "saleCount", reason: "missing" });
  } else if (!Number.isSafeInteger(input.saleCount) || input.saleCount < 1) {
    issues.push({ field: "saleCount", reason: "invalid" });
  }
  const maintenance = input.maintenanceMinutes;
  if (maintenance == null) {
    issues.push({ field: "maintenanceMinutes", reason: "missing" });
  } else if (!Number.isInteger(maintenance) || maintenance < 0 || maintenance > 300 || maintenance % 10 !== 0) {
    issues.push({ field: "maintenanceMinutes", reason: "invalid" });
  }
  if (input.storageMethod == null) {
    issues.push({ field: "storageMethod", reason: "missing" });
  } else if (!storageMethods.has(input.storageMethod)) {
    issues.push({ field: "storageMethod", reason: "invalid" });
  } else if (input.area == null) {
    issues.push({ field: "area", reason: "missing" });
  } else if (!validArea(input.area, input.storageMethod)) {
    issues.push({ field: "area", reason: "invalid" });
  }
  if (!validSettings(input.expenses, (item) =>
    (item.basis === "per-unit" || item.basis === "once" || item.basis === "revenue-percent")
    && isNonnegativeOrUnpriced(item.value))) {
    issues.push({ field: "expenses", reason: "invalid" });
  }
  if (!validSettings(input.remainingWork, (item) =>
    (item.basis === "per-unit" || item.basis === "once")
    && (item.channel !== "retail" || item.id !== "maintenance") && isNonnegativeOrUnpriced(item.minutes))) {
    issues.push({ field: "remainingWork", reason: "invalid" });
  }
  return { purchasePrice, plannedPrice, saleMonths };
}

function expenseRates(
  settings: ExpenseSetting[],
  unitPrices: Record<SalesChannel, Rational>,
): ExpenseRate[] {
  return settings.map((setting) => {
    const amount = decimal(setting.value);
    const costYen = amount && setting.basis === "revenue-percent"
      ? multiply(ratio(amount.numerator, amount.denominator * 100n), unitPrices[setting.channel])
      : amount;
    return { setting, costYen };
  });
}

function workRates(input: QuantityPlanInputs): WorkRate[] {
  const maintenance: WorkSetting = {
    id: "maintenance",
    label: "残りのメンテナンス",
    channel: "retail",
    basis: "per-unit",
    minutes: input.maintenanceMinutes,
  };
  return [maintenance, ...input.remainingWork].map((setting) => ({
    setting,
    minutes: decimal(setting.minutes),
  }));
}

function channelMargin(
  channel: SalesChannel,
  unitPrice: Rational,
  expenses: ExpenseRate[],
  work: WorkRate[],
): { perUnit: Rational; fixedCost: Rational } {
  let perUnit = unitPrice;
  let fixedCost = ZERO;
  const costs = [
    ...expenses.map(({ setting, costYen }) => ({ setting, costYen })),
    ...work.map(({ setting, minutes }) => ({ setting, costYen: minutes && multiply(minutes, laborPerMinute) })),
  ];
  for (const { setting, costYen } of costs) {
    if (setting.channel !== channel || costYen === null) continue;
    if (setting.basis === "once") fixedCost = add(fixedCost, costYen);
    else perUnit = subtract(perUnit, costYen);
  }
  return { perUnit, fixedCost };
}

function amountForChannel(
  rate: Rational | null,
  basis: ExpenseSetting["basis"],
  channelQuantity: bigint,
): Rational | null {
  if (rate === null) return null;
  if (channelQuantity === 0n) return ZERO;
  return basis === "once" ? rate : scale(rate, channelQuantity);
}

function itemStatus(value: Rational | null, quantity: bigint): ExpenseItem["status"] {
  if (value === null) return "unpriced";
  return quantity === 0n ? "not-applicable" : "counted";
}

type PlanModel = {
  quantity: bigint;
  areaM2PerBlock: Rational;
  unitsPerBlock: bigint;
  purchaseTotal: Rational;
  unitPrices: Record<SalesChannel, Rational>;
  expenses: ExpenseRate[];
  work: WorkRate[];
};

function candidateDetails(
  model: PlanModel,
  retailQuantity: bigint,
  saleInterval: Rational,
  storageCost: Rational,
  recovery: Rational,
): QuantityPlanCandidate {
  const { quantity, areaM2PerBlock, unitsPerBlock, purchaseTotal, unitPrices, expenses, work } = model;
  const quantities = { retail: retailQuantity, wholesale: quantity - retailQuantity };
  const gross = {
    retail: scale(unitPrices.retail, quantities.retail),
    wholesale: scale(unitPrices.wholesale, quantities.wholesale),
  };
  const net = { ...gross };
  const expenseItems = expenses.map(({ setting, costYen }) => {
    const channelQuantity = quantities[setting.channel];
    const total = amountForChannel(costYen, setting.basis, channelQuantity);
    if (total !== null) net[setting.channel] = subtract(net[setting.channel], total);
    return {
      ...setting,
      status: itemStatus(total, channelQuantity),
      costYen: total === null ? null : toNumber(total),
    };
  });
  let totalWork = ZERO;
  const workItems: WorkItem[] = work.map(({ setting, minutes }) => {
    const channelQuantity = quantities[setting.channel];
    const total = amountForChannel(minutes, setting.basis, channelQuantity);
    if (total !== null) totalWork = add(totalWork, total);
    return {
      ...setting,
      status: itemStatus(total, channelQuantity),
      totalMinutes: total === null ? null : toNumber(total),
      costYen: total === null ? null : toNumber(multiply(total, laborPerMinute)),
    };
  });
  const maxArea = scale(areaM2PerBlock, blockCount(quantity, unitsPerBlock));
  const retailSelloutMonths = toNumber(scale(saleInterval, retailQuantity));
  return {
    retailQuantity: Number(retailQuantity),
    wholesaleQuantity: Number(quantities.wholesale),
    retailSelloutMonths,
    clearanceMonths: quantities.wholesale === 0n ? retailSelloutMonths : Math.max(retailSelloutMonths, toNumber(wholesaleMonths)),
    retailGrossYen: toNumber(gross.retail),
    wholesaleGrossYen: toNumber(gross.wholesale),
    retailNetYen: toNumber(net.retail),
    wholesaleNetYen: toNumber(net.wholesale),
    workMinutes: toNumber(totalWork),
    workCostYen: toNumber(multiply(totalWork, laborPerMinute)),
    storageCostYen: toNumber(storageCost),
    maxAreaM2: toNumber(maxArea),
    maxAreaTsubo: toNumber(divide(maxArea, squareMetersPerTsubo)),
    recoveryYen: toNumber(recovery),
    afterPurchaseCostYen: toNumber(subtract(recovery, purchaseTotal)),
    expenseItems,
    workItems,
  };
}

function evaluateScenario(model: PlanModel, saleInterval: Rational): QuantityPlanScenario {
  const { quantity, areaM2PerBlock, unitsPerBlock, unitPrices, expenses, work } = model;
  const retail = channelMargin("retail", unitPrices.retail, expenses, work);
  const wholesale = channelMargin("wholesale", unitPrices.wholesale, expenses, work);
  const wholesaleBase = scale(wholesale.perUnit, quantity);
  const retailPremium = subtract(retail.perUnit, wholesale.perUnit);

  // Use exact integer ticks for both events, then one common denominator for all candidate amounts.
  const timeDenominator = commonDenominator([saleInterval, wholesaleMonths]);
  const saleTicks = saleInterval.numerator * (timeDenominator / saleInterval.denominator);
  const wholesaleTicks = wholesaleMonths.numerator * (timeDenominator / wholesaleMonths.denominator);
  const storagePerTick = divide(
    multiply(divide(areaM2PerBlock, squareMetersPerTsubo), storagePerTsuboMonth),
    ratio(timeDenominator),
  );
  const yenDenominator = commonDenominator([
    wholesaleBase, retailPremium, retail.fixedCost, wholesale.fixedCost, storagePerTick,
  ]);
  const scaledYen = (value: Rational) => value.numerator * (yenDenominator / value.denominator);
  const base = scaledYen(wholesaleBase);
  const premium = scaledYen(retailPremium);
  const retailFixed = scaledYen(retail.fixedCost);
  const wholesaleFixed = scaledYen(wholesale.fixedCost);
  const storageRate = scaledYen(storagePerTick);

  let bestQuantity = 0n;
  let bestRecovery = 0n;
  let bestStorage = 0n;
  let allRetailRecovery = 0n;
  let allRetailStorage = 0n;
  for (let retailQuantity = 0n; retailQuantity <= quantity; retailQuantity++) {
    const storage = storageRate * storageBlockTicks(quantity, retailQuantity, unitsPerBlock, saleTicks, wholesaleTicks);
    const recovery = base + premium * retailQuantity
      - (retailQuantity > 0n ? retailFixed : 0n)
      - (retailQuantity < quantity ? wholesaleFixed : 0n) - storage;
    if (retailQuantity === 0n || recovery > bestRecovery) {
      bestQuantity = retailQuantity;
      bestRecovery = recovery;
      bestStorage = storage;
    }
    // Values from the last iteration are the all-retail comparison.
    allRetailRecovery = recovery;
    allRetailStorage = storage;
  }

  const allRetail = candidateDetails(
    model, quantity, saleInterval, ratio(allRetailStorage, yenDenominator), ratio(allRetailRecovery, yenDenominator),
  );
  const recommended = bestQuantity === quantity ? allRetail : candidateDetails(
    model, bestQuantity, saleInterval, ratio(bestStorage, yenDenominator), ratio(bestRecovery, yenDenominator),
  );
  return {
    retailUnitsPerMonth: toNumber(divide(ratio(1n), saleInterval)),
    saleIntervalMonths: toNumber(saleInterval),
    recommended,
    allRetail,
    differenceYen: toNumber(ratio(bestRecovery - allRetailRecovery, yenDenominator)),
  };
}

export function calculateQuantityPlan(input: QuantityPlanInput): QuantityPlanResult {
  const issues: QuantityPlanIssue[] = [];
  const { purchasePrice, plannedPrice, saleMonths } = validateInput(input, issues);
  if (issues.length || !purchasePrice || !plannedPrice || !saleMonths) return { ok: false, issues };

  const inputs = input as QuantityPlanInputs;
  const quantity = BigInt(inputs.quantity);
  const unitPrices = { retail: plannedPrice, wholesale: purchasePrice };
  const model: PlanModel = {
    quantity,
    unitsPerBlock: BigInt(inputs.area.unitsPerBlock),
    areaM2PerBlock: decimal(inputs.area.areaM2PerBlock)!,
    purchaseTotal: scale(purchasePrice, quantity),
    unitPrices,
    expenses: expenseRates(inputs.expenses, unitPrices),
    work: workRates(inputs),
  };
  const saleInterval = divide(saleMonths, ratio(BigInt(inputs.saleCount)));
  try {
    return {
      ok: true,
      plan: {
        logicVersion: QUANTITY_PLAN_LOGIC_VERSION,
        rules: QUANTITY_PLAN_RULES,
        inputs,
        purchaseTotalYen: toNumber(model.purchaseTotal),
        ...evaluateScenario(model, saleInterval),
        halfPace: evaluateScenario(model, scale(saleInterval, 2n)),
      },
    };
  } catch (error) {
    if (error instanceof CalculationOutOfRange) return { ok: false, issues: [{ field: "calculation", reason: "out-of-range" }] };
    throw error;
  }
}
