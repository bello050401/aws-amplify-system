import assert from "node:assert/strict";
import { calculateQuantityPlan, MAX_QUANTITY_PLAN_STOCK } from "../lib/inventory/quantityPlanning/engine";
import { storageBlockTicks } from "../lib/inventory/quantityPlanning/math";
import type {
  QuantityPlan,
  QuantityPlanCandidate,
  QuantityPlanInput,
  QuantityPlanInputs,
  QuantityPlanIssue,
  QuantityPlanScenario,
} from "../lib/inventory/quantityPlanning/types";

const base: QuantityPlanInputs = {
  quantity: 8,
  purchaseUnitPriceYen: 5_000,
  plannedUnitPriceYen: 9_000,
  plannedPriceSource: "registered",
  saleMonths: "0.5",
  saleCount: 1,
  maintenanceMinutes: 0,
  storageMethod: "stack",
  area: { method: "stack", source: "measured-category", areaM2PerBlock: "3.305785", unitsPerBlock: 4 },
  expenses: [],
  remainingWork: [],
};

function plan(input: QuantityPlanInputs = base): QuantityPlan {
  const result = calculateQuantityPlan(input);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("Expected successful plan");
  return result.plan;
}

function checkIssue(
  patch: Partial<QuantityPlanInput>,
  issue: QuantityPlanIssue,
): void {
  const result = calculateQuantityPlan({ ...base, ...patch });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("Expected validation failure");
  assert.ok(result.issues.some(({ field, reason }) => field === issue.field && reason === issue.reason), JSON.stringify(result));
}

function close(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${actual} vs ${expected}`);
}

const empty = plan({ ...base, quantity: 0, purchaseUnitPriceYen: 0, plannedUnitPriceYen: 0 });
for (const scenario of [empty, empty.halfPace]) {
  assert.deepEqual(scenario.recommended, scenario.allRetail);
  assert.equal(scenario.recommended.retailQuantity + scenario.recommended.wholesaleQuantity, 0);
  assert.equal(scenario.recommended.clearanceMonths, 0);
  assert.equal(scenario.recommended.maxAreaM2, 0);
  assert.equal(scenario.recommended.recoveryYen, 0);
}

const exactTie = plan({
  ...base, quantity: 1, saleMonths: "1.4", saleCount: 3, purchaseUnitPriceYen: 0, plannedUnitPriceYen: "0.00",
});
assert.equal(exactTie.recommended.retailQuantity, 0);
assert.equal(exactTie.recommended.wholesaleQuantity, 1);
assert.equal(exactTie.differenceYen, 0);
assert.equal(exactTie.recommended.storageCostYen, exactTie.allRetail.storageCostYen);
close(exactTie.allRetail.retailSelloutMonths * 30, 14);
assert.equal(storageBlockTicks(8n, 1n, 4n, 14n, 14n), 28n);

const exactTinyPremium = plan({
  ...base,
  quantity: 1,
  saleMonths: "1.4",
  saleCount: 3,
  purchaseUnitPriceYen: "10000000000",
  plannedUnitPriceYen: "10000000000.0000000001",
});
assert.equal(exactTinyPremium.recommended.retailQuantity, 1);
assert.equal(exactTinyPremium.halfPace.recommended.retailQuantity, 0);

const stack = plan();
assert.equal(stack.allRetail.maxAreaTsubo, 2);
assert.equal(stack.allRetail.storageCostYen, 5_500 * 0.5 * (2 + 2 + 2 + 2 + 1 + 1 + 1 + 1));
assert.equal(plan({ ...base, quantity: 7 }).allRetail.maxAreaTsubo, 2);
assert.equal(plan({ ...base, quantity: 4 }).allRetail.maxAreaTsubo, 1);
assert.equal(plan({ ...base, quantity: 4, plannedUnitPriceYen: "1000000" }).recommended.retailQuantity, 4);
assert.equal(plan({ ...base, plannedUnitPriceYen: 0 }).recommended.retailQuantity, 0);
assert.equal(plan({ ...base, quantity: 1, saleMonths: "0.1" }).allRetail.storageCostYen, 550);

const longHorizon = plan({ ...base, quantity: 1, saleMonths: "12000000000000.5", saleCount: 1 });
assert.equal(longHorizon.allRetail.retailSelloutMonths, 12000000000000.5);
assert.equal(longHorizon.halfPace.allRetail.retailSelloutMonths, 24000000000001);
close(longHorizon.allRetail.storageCostYen, 5500 * 12000000000000.5);
assert.ok(longHorizon.retailUnitsPerMonth > 0 && longHorizon.retailUnitsPerMonth < 1e-12);

const costs = plan({
  ...base,
  quantity: 3,
  purchaseUnitPriceYen: 1_000,
  plannedUnitPriceYen: 100_000,
  maintenanceMinutes: 10,
  expenses: [
    { id: "commission", label: "手数料", channel: "retail", basis: "revenue-percent", value: "2.5" },
    { id: "shipping", label: "送料", channel: "retail", basis: "per-unit", value: null },
    { id: "lot", label: "業販費用", channel: "wholesale", basis: "once", value: 200 },
    { id: "none", label: "費用設定", channel: "retail", basis: "per-unit", value: 0 },
  ],
  remainingWork: [
    { id: "photography", label: "撮影", channel: "retail", basis: "once", minutes: 30 },
    { id: "dispatch", label: "発送", channel: "retail", basis: "per-unit", minutes: null },
    { id: "disassembly", label: "分解", channel: "retail", basis: "per-unit", minutes: 5 },
    { id: "disassembly", label: "分解", channel: "wholesale", basis: "per-unit", minutes: 5 },
  ],
});
assert.equal(costs.purchaseTotalYen, 3000);
assert.equal(costs.recommended.retailQuantity, 3);
assert.equal(costs.recommended.workMinutes, 30 + 30 + 15);
assert.equal(costs.recommended.workCostYen, 2500);
assert.equal(costs.recommended.retailGrossYen, 300_000);
assert.equal(costs.recommended.retailNetYen, 292_500);
assert.equal(costs.recommended.recoveryYen, 292_500 - 2500 - 8_250);
assert.equal(costs.recommended.afterPurchaseCostYen, costs.recommended.recoveryYen - 3000);
assert.deepEqual(costs.recommended.expenseItems.map(({ status, costYen }) => [status, costYen]), [
  ["counted", 7500], ["unpriced", null], ["not-applicable", 0], ["counted", 0],
]);
assert.equal(costs.recommended.workItems.find(({ id }) => id === "dispatch")?.status, "unpriced");
const wholesaleOnly = plan({ ...costs.inputs, plannedUnitPriceYen: 0 });
assert.equal(wholesaleOnly.recommended.retailQuantity, 0);
assert.equal(wholesaleOnly.recommended.workMinutes, 15);
assert.equal(wholesaleOnly.recommended.wholesaleNetYen, 2800);
assert.equal(wholesaleOnly.recommended.expenseItems.find(({ id }) => id === "shipping")?.status, "unpriced");

const mixed = plan({
  ...costs.inputs,
  quantity: 2,
  purchaseUnitPriceYen: 5_000,
  plannedUnitPriceYen: 7_600,
  saleMonths: 0.5,
  maintenanceMinutes: 0,
  expenses: [{ id: "round", label: "業販費", channel: "wholesale", basis: "once", value: 50 }],
  remainingWork: [
    { id: "disassembly", label: "分解", channel: "retail", basis: "per-unit", minutes: 5 },
    { id: "disassembly", label: "分解", channel: "wholesale", basis: "per-unit", minutes: 5 },
  ],
});
assert.equal(mixed.recommended.retailQuantity, 1);
assert.equal(mixed.recommended.wholesaleQuantity, 1);
assert.equal(mixed.recommended.workMinutes, 10);
assert.equal(mixed.recommended.wholesaleNetYen, 4950);
assert.equal(mixed.halfPace.recommended.retailQuantity, 0);

// Both 60 cm × 1 m and 0.6 m × 100 cm normalize to this area in the source adapter.
const normalizedArea = { method: "flat", source: "inventory", unitsPerBlock: 1 } as const;
const areaNumber = plan({ ...base, storageMethod: "flat", area: { ...normalizedArea, areaM2PerBlock: 0.6 } });
const areaDecimal = plan({ ...base, storageMethod: "flat", area: { ...normalizedArea, areaM2PerBlock: "0.600" } });
assert.deepEqual(areaNumber.allRetail, areaDecimal.allRetail);
assert.equal(areaNumber.allRetail.maxAreaM2, 4.8);

checkIssue({ purchaseUnitPriceYen: null }, { field: "purchaseUnitPriceYen", reason: "missing" });
checkIssue({ quantity: null }, { field: "quantity", reason: "missing" });
checkIssue({ quantity: MAX_QUANTITY_PLAN_STOCK + 1 }, { field: "quantity", reason: "out-of-range" });
checkIssue({ quantity: -1 }, { field: "quantity", reason: "invalid" });
checkIssue({ plannedUnitPriceYen: null }, { field: "plannedUnitPriceYen", reason: "missing" });
checkIssue({ maintenanceMinutes: null }, { field: "maintenanceMinutes", reason: "missing" });
checkIssue({ maintenanceMinutes: 15 }, { field: "maintenanceMinutes", reason: "invalid" });
checkIssue({ storageMethod: null }, { field: "storageMethod", reason: "missing" });
checkIssue({ area: null }, { field: "area", reason: "missing" });
checkIssue({ storageMethod: "flat", area: { ...base.area, method: "flat" } }, { field: "area", reason: "invalid" });
checkIssue({ saleMonths: 0 }, { field: "saleMonths", reason: "invalid" });
checkIssue({ saleMonths: "-0.5" }, { field: "saleMonths", reason: "invalid" });
checkIssue({ saleMonths: "0x10" }, { field: "saleMonths", reason: "invalid" });
checkIssue({ saleMonths: "1e-400" }, { field: "calculation", reason: "out-of-range" });
checkIssue({ saleCount: 0 }, { field: "saleCount", reason: "invalid" });
checkIssue({ saleCount: 1.1 }, { field: "saleCount", reason: "invalid" });
checkIssue({ expenses: [costs.inputs.expenses[0], costs.inputs.expenses[0]] }, { field: "expenses", reason: "invalid" });
checkIssue({ remainingWork: [...costs.inputs.remainingWork, costs.inputs.remainingWork[0]] }, {
  field: "remainingWork", reason: "invalid",
});

function simulateStorage(
  quantity: number,
  retail: number,
  unitsPerBlock: number,
  saleTime: number,
  wholesaleTime: number,
): number {
  const events = Array.from({ length: retail }, (_, index) => ({ time: (index + 1) * saleTime, sold: 1 }));
  if (quantity > retail) events.push({ time: wholesaleTime, sold: quantity - retail });
  events.sort((left, right) => left.time - right.time);
  let elapsed = 0;
  let remaining = quantity;
  let occupied = 0;
  for (const { time, sold } of events) {
    occupied += (time - elapsed) * Math.ceil(remaining / unitsPerBlock);
    remaining -= sold;
    elapsed = time;
  }
  assert.equal(remaining, 0);
  return occupied;
}

function simulateCandidate(input: QuantityPlanInputs, retail: number, interval: number) {
  const wholesale = input.quantity - retail;
  const quantities = { retail, wholesale };
  const gross = {
    retail: retail * Number(input.plannedUnitPriceYen),
    wholesale: wholesale * Number(input.purchaseUnitPriceYen),
  };
  const net = { ...gross };
  for (const { channel, basis, value } of input.expenses) {
    if (quantities[channel] === 0 || value === null) continue;
    const amount = Number(value);
    if (basis === "once") net[channel] -= amount;
    else if (basis === "per-unit") net[channel] -= amount * quantities[channel];
    else net[channel] -= gross[channel] * amount / 100;
  }
  let workMinutes = retail * input.maintenanceMinutes;
  for (const { channel, basis, minutes } of input.remainingWork) {
    if (quantities[channel] === 0 || minutes === null) continue;
    workMinutes += Number(minutes) * (basis === "once" ? 1 : quantities[channel]);
  }
  const storageCostYen = simulateStorage(input.quantity, retail, input.area.unitsPerBlock, interval, 14 / 30)
    * Number(input.area.areaM2PerBlock) * 5500 / 3.305785;
  const workCostYen = workMinutes * 2000 / 60;
  const recoveryYen = net.retail + net.wholesale - workCostYen - storageCostYen;
  return {
    retailQuantity: retail, wholesaleQuantity: wholesale, retailSelloutMonths: retail * interval,
    clearanceMonths: Math.max(retail * interval, wholesale > 0 ? 14 / 30 : 0),
    retailGrossYen: gross.retail, wholesaleGrossYen: gross.wholesale,
    retailNetYen: net.retail, wholesaleNetYen: net.wholesale, storageCostYen, workMinutes, workCostYen, recoveryYen,
    maxAreaM2: Math.ceil(input.quantity / input.area.unitsPerBlock) * Number(input.area.areaM2PerBlock),
    afterPurchaseCostYen: recoveryYen - input.quantity * Number(input.purchaseUnitPriceYen),
  };
}

function matchSimulatedScenario(input: QuantityPlanInputs, actual: QuantityPlanScenario, paceDivisor: number) {
  const interval = Number(input.saleMonths) / input.saleCount * paceDivisor;
  close(actual.retailUnitsPerMonth, 1 / interval);
  const candidates = Array.from({ length: input.quantity + 1 }, (_, retail) => simulateCandidate(input, retail, interval));
  const baseline = candidates[candidates.length - 1];
  const best = candidates.reduce((left, right) => right.recoveryYen > left.recoveryYen + 1e-8 ? right : left);
  const match = (candidate: QuantityPlanCandidate, expected: typeof best) => {
    assert.equal(candidate.retailQuantity, expected.retailQuantity);
    assert.equal(candidate.retailQuantity + candidate.wholesaleQuantity, input.quantity);
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) close(candidate[key], expected[key]);
  };
  match(actual.allRetail, baseline);
  match(actual.recommended, best);
  close(actual.differenceYen, best.recoveryYen - baseline.recoveryYen);
}

let seed = 0x51A6A1;
function rand(limit: number): number {
  seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
  return Math.floor(seed / 2 ** 32 * limit);
}

let storageCases = 0;
const randomCases = 500;
for (let trial = 0; trial < randomCases; trial++) {
  const quantity = rand(17);
  const capacity = 1 + rand(7);
  const saleTicks = 1 + rand(40);
  const wholesaleTicks = 1 + rand(70);
  for (let retail = 0; retail <= quantity; retail++) {
    const expected = simulateStorage(quantity, retail, capacity, saleTicks, wholesaleTicks);
    const actual = storageBlockTicks(BigInt(quantity), BigInt(retail), BigInt(capacity), BigInt(saleTicks), BigInt(wholesaleTicks));
    assert.equal(actual, BigInt(expected));
    storageCases++;
  }
  const method = capacity === 1 ? "flat" : trial % 2 ? "stack" : "disassembled";
  const input: QuantityPlanInputs = {
    ...costs.inputs,
    quantity,
    purchaseUnitPriceYen: rand(15_000),
    plannedUnitPriceYen: rand(20_000) + rand(10) / 10,
    saleMonths: trial % 10 === 0 ? "1.4" : (1 + rand(40)) / 10,
    saleCount: trial % 10 === 0 ? 3 : 1 + rand(15),
    maintenanceMinutes: rand(31) * 10,
    storageMethod: method,
    area: { method, source: "provisional-category", unitsPerBlock: capacity, areaM2PerBlock: (1 + rand(300)) / 100 },
  };
  const result = plan(input);
  matchSimulatedScenario(input, result, 1);
  matchSimulatedScenario(input, result.halfPace, 2);
}

const guardStart = performance.now();
const maxStock = plan({ ...base, quantity: MAX_QUANTITY_PLAN_STOCK });
assert.equal(maxStock.recommended.retailQuantity + maxStock.recommended.wholesaleQuantity, MAX_QUANTITY_PLAN_STOCK);
assert.equal(maxStock.allRetail.retailQuantity, MAX_QUANTITY_PLAN_STOCK);
assert.equal(maxStock.halfPace.allRetail.retailQuantity, MAX_QUANTITY_PLAN_STOCK);
assert.doesNotThrow(() => JSON.stringify(maxStock));
console.log(`Quantity planning verified. ${storageCases} allocation timelines and ${randomCases * 2} full scenarios matched simulation.`);
console.log(`Stock limit ${MAX_QUANTITY_PLAN_STOCK.toLocaleString()} evaluated at both paces in ${Math.round(performance.now() - guardStart)} ms.`);
