import type {
  QuantityPlanningConditions, QuantityPlanningSettingsResult, QuantityPlanningSettingsSaveRequest, QuantityPlanningSource,
  SavedQuantityPlan,
} from "./contracts";
import { calculateQuantityPlan, QUANTITY_PLAN_LOGIC_VERSION } from "./engine";
import type { QuantityPlanningPorts } from "./useQuantityPlanning";

export type QuantityPreviewMode = "registered" | "unregistered" | "zero" | "stock-missing" | "viewer" | "no-area" | "changed" | "retry" | "live-change";
export const quantityPreviewId = "11111111-1111-4111-8111-000000000001";

const defaultSource = {
  inventoryId: quantityPreviewId, title: "オーク無垢材 ベンチ 木座 ナチュラル 幅120cm", categoryId: "bench",
  categoryName: "ベンチ・オットマン", workflowCategoryName: "販売中", brand: "家具ブランド（見本）",
  quantity: 8, purchaseUnitPriceYen: 5_000, purchaseTotalYen: 40_000, plannedUnitPriceYen: 8_500, fingerprint: "fixture-stock-1",
};

export function quantityPreviewSource(mode: QuantityPreviewMode): QuantityPlanningSource {
  if (mode === "changed") return { ...defaultSource, quantity: 7, purchaseTotalYen: 35_000, fingerprint: "fixture-stock-2" };
  if (mode === "unregistered") return { ...defaultSource, plannedUnitPriceYen: null };
  if (mode === "zero") return { ...defaultSource, plannedUnitPriceYen: 0 };
  if (mode === "stock-missing") return { ...defaultSource, purchaseUnitPriceYen: null, purchaseTotalYen: null };
  return defaultSource;
}

function storageKey(mode: QuantityPreviewMode) {
  return "bello-quantity-preview:" + (mode === "changed" || mode === "retry" || mode === "viewer" || mode === "live-change" ? "registered" : mode);
}

export function quantityPreviewPorts(mode: QuantityPreviewMode, storage: Pick<Storage, "getItem" | "setItem">): QuantityPlanningPorts {
  const source = () => quantityPreviewSource(mode === "live-change" && storage.getItem("bello-quantity-preview:changed") ? "changed" : mode);
  const key = storageKey(mode);
  const latest = () => {
    const saved: string | null = storage.getItem(key);
    return saved ? JSON.parse(saved) as { latest: SavedQuantityPlan; fingerprint: string; operationId: string } : null;
  };
  const snapshot = () => {
    const saved = latest();
    return {
      status: "ok" as const, source: source(), latest: saved?.latest ?? null,
      stale: !!saved && saved.fingerprint !== source().fingerprint, canEdit: mode !== "viewer",
      logicVersion: QUANTITY_PLAN_LOGIC_VERSION, settingsVersion: 1,
    };
  };
  const area = (conditions: QuantityPlanningConditions) => {
    const method = conditions.storageMethod;
    return mode === "no-area" || !method ? null : {
      method,
      source: method === "flat" ? "inventory" as const : "measured-category" as const,
      areaM2PerBlock: method === "flat" ? 0.6 : 2, unitsPerBlock: method === "flat" ? 1 : 4,
      reference: method === "flat" ? "幅120cm × 奥行50cm（見本）" : "4個収納の実測値（見本）",
    };
  };
  const calculate = (conditions: QuantityPlanningConditions) => {
    const facts = source();
    return calculateQuantityPlan({
      quantity: facts.quantity, purchaseUnitPriceYen: facts.purchaseUnitPriceYen,
      plannedUnitPriceYen: facts.plannedUnitPriceYen ?? conditions.manualPlannedUnitPriceYen,
      plannedPriceSource: facts.plannedUnitPriceYen === null ? "manual" : "registered",
      saleMonths: conditions.saleMonths, saleCount: conditions.saleCount, maintenanceMinutes: conditions.maintenanceMinutes,
      storageMethod: conditions.storageMethod, area: area(conditions),
      expenses: [{ id: "retail-fee", label: "通常販売手数料", channel: "retail", basis: "revenue-percent", value: null }],
      remainingWork: [],
    });
  };
  let failedOperation: string | null = null;

  return {
    read: async () => snapshot(),
    calculate: async (_, conditions) => {
      const calculation = calculate(conditions);
      return {
        status: "ok", source: source(), calculation, token: calculation.ok && mode !== "viewer" ? source().fingerprint : null,
        logicVersion: QUANTITY_PLAN_LOGIC_VERSION, settingsVersion: 1,
      };
    },
    save: async (id, { conditions, token, operationId }) => {
      if (mode === "viewer") return { status: "forbidden", message: "計算結果を保存する権限がありません。" };
      if (token !== source().fingerprint) return { status: "conflict", message: "再計算が必要です。" };
      if (mode === "retry") {
        if (!failedOperation) {
          failedOperation = operationId;
          throw new Error("Lost write response fixture");
        }
        if (failedOperation !== operationId) return { status: "invalid", message: "操作IDが変わりました（検証用）。" };
      }
      const existing = latest();
      if (existing?.operationId === operationId) return snapshot();
      const calculation = calculate(conditions);
      if (!calculation.ok) return { status: "invalid", message: "計算条件を確認してください。" };
      const updated: SavedQuantityPlan = {
        inventoryId: id, revision: (existing?.latest.revision ?? 0) + 1, conditions, calculation,
        calculatedAt: "2026-11-14T03:00:00.000Z", calculatedBy: "検証スタッフ",
        logicVersion: calculation.plan.logicVersion, settingsVersion: 1,
      };
      storage.setItem(key, JSON.stringify({ latest: updated, operationId, fingerprint: source().fingerprint }));
      return snapshot();
    },
  };
}

type Settings = Extract<QuantityPlanningSettingsResult, { status: "ok" }>;
export function previewSettingsPorts(storage: Pick<Storage, "getItem" | "setItem">) {
  const key = "bello-quantity-preview:settings";
  const read = (): Settings => {
    const saved = storage.getItem(key);
    return saved ? JSON.parse(saved) as Settings : {
      status: "ok", revision: 0, taxonomyRevision: 1, categories: [{ id: "bench", label: "ベンチ・オットマン" }],
      settings: {
        flatAllowancePercent: 0, standards: [], remainingWork: [],
        expenses: [{ id: "retail-fee", label: "通常販売手数料", channel: "retail", basis: "revenue-percent", value: null }],
      },
    };
  };
  return {
    read: async () => read(),
    save: async (request: QuantityPlanningSettingsSaveRequest): Promise<QuantityPlanningSettingsResult> => {
      const current = read();
      if (current.revision !== request.expectedRevision || current.taxonomyRevision !== request.expectedTaxonomyRevision) {
        return { status: "conflict", message: "最新設定を読み込んでください。" };
      }
      const saved = { ...current, revision: current.revision + 1, settings: request.settings };
      storage.setItem(key, JSON.stringify(saved));
      return saved;
    },
  };
}
