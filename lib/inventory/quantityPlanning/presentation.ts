import type { QuantityPlanningConditions, QuantityPlanningSource } from "./contracts";
import type { AreaSource, QuantityPlan, QuantityPlanIssue, StorageMethod } from "./types";

export const storageMethods = {
  flat: "平置き",
  stack: "重ねる",
  disassembled: "分解",
} satisfies Record<StorageMethod, string>;

export const areaSources = {
  inventory: "在庫の登録寸法・保管情報",
  "measured-category": "カテゴリの実測標準",
  "provisional-category": "カテゴリの暫定標準",
} satisfies Record<AreaSource, string>;

export const maintenanceChoices = Array.from({ length: 31 }, (_, index) => index * 10);
export const planningCaveat = "入力した販売ペースに基づく、商品単体の目安です。";
export const estimatedArea = "保管面積はカテゴリ標準値による推定です";
export const settingsPath = "/inventory/settings?tab=quantityPlanning";

export type QuantityPlanningDraft = {
  saleMonths: string;
  saleCount: string;
  maintenanceMinutes: number | null;
  storageMethod: StorageMethod | null;
  manualPrice: string;
};

export function draftFromConditions(conditions?: QuantityPlanningConditions): QuantityPlanningDraft {
  return {
    saleMonths: String(conditions?.saleMonths ?? ""),
    saleCount: String(conditions?.saleCount ?? ""),
    maintenanceMinutes: conditions?.maintenanceMinutes ?? null,
    storageMethod: conditions?.storageMethod ?? null,
    manualPrice: String(conditions?.manualPlannedUnitPriceYen ?? ""),
  };
}

type LabelValue = readonly [label: string, value: string];
const decimal = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
export function parseDraft(draft: QuantityPlanningDraft, source: QuantityPlanningSource):
  { ok: true; conditions: QuantityPlanningConditions } | { ok: false; issues: QuantityPlanIssue[] } {
  const issues: QuantityPlanIssue[] = [];
  const saleMonths = draft.saleMonths.trim();
  const saleCount = draft.saleCount.trim();
  const manualPrice = draft.manualPrice.trim();
  const needsPrice = source.plannedUnitPriceYen === null;
  if (!decimal.test(saleMonths) || !(Number(saleMonths) > 0) || !Number.isFinite(Number(saleMonths))) {
    issues.push({ field: "saleMonths", reason: saleMonths ? "invalid" : "missing" });
  }
  if (!/^\d+$/.test(saleCount) || !Number.isSafeInteger(Number(saleCount)) || Number(saleCount) < 1) {
    issues.push({ field: "saleCount", reason: saleCount ? "invalid" : "missing" });
  }
  if (draft.maintenanceMinutes === null) issues.push({ field: "maintenanceMinutes", reason: "missing" });
  if (draft.storageMethod === null) issues.push({ field: "storageMethod", reason: "missing" });
  if (needsPrice && (!decimal.test(manualPrice) || !Number.isFinite(Number(manualPrice)))) {
    issues.push({ field: "plannedUnitPriceYen", reason: manualPrice ? "invalid" : "missing" });
  }
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    conditions: {
      saleMonths, saleCount: Number(saleCount), maintenanceMinutes: draft.maintenanceMinutes,
      storageMethod: draft.storageMethod, manualPlannedUnitPriceYen: needsPrice ? manualPrice : null,
    },
  };
}

const issueLabels: Record<QuantityPlanIssue["field"], string> = {
  quantity: "現在庫数量", purchaseUnitPriceYen: "購入単価", plannedUnitPriceYen: "予定販売単価",
  plannedPriceSource: "予定販売単価の参照元", saleMonths: "販売ペースの月数", saleCount: "販売見込み個数",
  maintenanceMinutes: "残りのメンテナンス時間", storageMethod: "保管方法", area: "保管面積",
  expenses: "将来費用の設定", remainingWork: "残作業の設定", calculation: "計算結果",
};

export function issueMessage(issue: QuantityPlanIssue) {
  const label = issueLabels[issue.field];
  if (issue.field === "area") return "この保管方法の保管面積を確定できません。カテゴリ標準または在庫の登録寸法を確認してください。";
  if (issue.field === "saleMonths") return "販売ペースの月数に正の数を入力してください。";
  if (issue.field === "saleCount") return "販売見込み個数に1以上の整数を入力してください。";
  if (issue.reason === "missing") return `${label}が未登録または未入力です。`;
  return `${label}の値を確認してください。`;
}

export function missingStockIssues(source: QuantityPlanningSource): QuantityPlanIssue[] {
  const issues: QuantityPlanIssue[] = [];
  if (source.quantity === null) issues.push({ field: "quantity", reason: "missing" });
  if (source.purchaseUnitPriceYen === null) issues.push({ field: "purchaseUnitPriceYen", reason: "missing" });
  return issues;
}

export function stockIssue(issue: QuantityPlanIssue) {
  return issue.field === "quantity" || issue.field === "purchaseUnitPriceYen";
}

const compact = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 3 });
const currency = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 });
export const yen = (value: number | string | null) => value === null ? "未登録" : `${currency.format(Number(value))}円`;
export const units = (value: number) => `${compact.format(value)}個`;
const pace = (value: number) => value > 0 && value < 0.001 ? value.toPrecision(3) : compact.format(value);
const months = (value: number) => value > 0 && value < 0.001 ? "0.001ヶ月未満" : `${compact.format(value)}ヶ月`;

export function sourceFacts(source: QuantityPlanningSource): LabelValue[] {
  return [
    ["現在庫数量", source.quantity === null ? "未登録" : units(source.quantity)],
    ["購入単価（1個あたり）", yen(source.purchaseUnitPriceYen)],
    ["購入総額（全数量の合計）", yen(source.purchaseTotalYen)],
    ["予定販売単価（1個あたり）", yen(source.plannedUnitPriceYen)],
  ];
}

export function resultFacts(plan: QuantityPlan): LabelValue[] {
  const result = plan.recommended;
  return [
    ["今後の費用控除後回収額", yen(result.recoveryYen)],
    ["原価控除後の見込額", yen(result.afterPurchaseCostYen)],
    ["全数通常販売との差額", `${plan.differenceYen > 0 ? "+" : ""}${yen(plan.differenceYen)}`],
    ["通常販売分の完売見込み", result.retailQuantity === 0 ? "対象なし" : months(result.retailSelloutMonths)],
    ["今後必要な作業時間", `${compact.format(result.workMinutes)}分`],
    ["保管費合計", yen(result.storageCostYen)],
    ["最大保管面積", `${compact.format(result.maxAreaM2)}㎡（${compact.format(result.maxAreaTsubo)}坪）`],
  ];
}

export function resultDetails(plan: QuantityPlan): LabelValue[] {
  const { inputs, recommended: result, allRetail, halfPace, rules } = plan;
  const { area } = inputs;
  return [
    ["予定販売単価", `${yen(inputs.plannedUnitPriceYen)}／1個（${inputs.plannedPriceSource === "registered" ? "在庫登録価格" : "計算条件の補完価格"}）`],
    ["業販単価", `${yen(inputs.purchaseUnitPriceYen)}／1個（購入単価）`],
    ["販売ペース", `${inputs.saleMonths}ヶ月で${units(inputs.saleCount)}（月${pace(plan.retailUnitsPerMonth)}個）`],
    ["通常販売の売れ方", `${months(plan.saleIntervalMonths)}ごとに1個ずつ販売`],
    ["業販時期・月換算", `${rules.wholesaleAfterDays}日後に一括業販／1ヶ月${rules.daysPerMonth}日`],
    ["保管終了まで", months(result.clearanceMonths)],
    ["保管方法・面積の根拠", `${storageMethods[inputs.storageMethod]}・${areaSources[area.source]}`],
    ["1区画あたり", `${compact.format(Number(area.areaM2PerBlock))}㎡／${units(area.unitsPerBlock)}`],
    ...(area.reference ? [["面積の参照情報", area.reference] as const] : []),
    ["保管費単価", `${yen(rules.storageYenPerTsuboMonth)}／坪・月（在庫が減るごとに反映）`],
    ["人件費単価", `${yen(rules.laborYenPerHour)}／時`],
    ["残りメンテナンス", `${inputs.maintenanceMinutes}分／通常販売1個`],
    ["通常販売収入（費用控除前／後）", `${yen(result.retailGrossYen)}／${yen(result.retailNetYen)}`],
    ["業販収入（費用控除前／後）", `${yen(result.wholesaleGrossYen)}／${yen(result.wholesaleNetYen)}`],
    ["今後の作業費合計", yen(result.workCostYen)],
    ...result.workItems.map(item => [item.label, item.status === "counted" ? `${compact.format(item.totalMinutes ?? 0)}分・${yen(item.costYen)}` : item.status === "unpriced" ? "未計上" : "対象なし"] as const),
    ...result.expenseItems.map(item => [item.label, item.status === "counted" ? yen(item.costYen) : item.status === "unpriced" ? "未計上" : "対象なし"] as const),
    ["計上状況", "設定のない将来費用・残作業は未計上"],
    ["全数通常販売の回収額・完売時期", `${yen(allRetail.recoveryYen)}・${months(allRetail.retailSelloutMonths)}`],
    ["半分の販売ペースでの推奨", `通常販売 ${units(halfPace.recommended.retailQuantity)}／業販 ${units(halfPace.recommended.wholesaleQuantity)}${halfPace.recommended.retailQuantity !== result.retailQuantity ? "（推奨数量が変わります）" : ""}`],
  ];
}

export function allocation(plan: QuantityPlan) {
  const { retailQuantity, wholesaleQuantity } = plan.recommended;
  const total = retailQuantity + wholesaleQuantity;
  return {
    retailQuantity, wholesaleQuantity,
    retailPercentage: total ? 100 * retailQuantity / total : 0,
  };
}
