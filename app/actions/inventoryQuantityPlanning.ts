'use server';

import type { QuantityPlanningConditions, QuantityPlanningSaveRequest, QuantityPlanningSettingsSaveRequest } from '@/lib/inventory/quantityPlanning/contracts';
import { quantityPlanningServer } from '@/lib/inventory/quantityPlanning/server';

export async function readQuantityPlanning(inventoryId: string) {
  return quantityPlanningServer().read(inventoryId);
}

export async function calculateInventoryQuantityPlan(inventoryId: string, conditions: QuantityPlanningConditions) {
  return quantityPlanningServer().calculate(inventoryId, conditions);
}

export async function saveInventoryQuantityPlan(inventoryId: string, request: QuantityPlanningSaveRequest) {
  return quantityPlanningServer().save(inventoryId, request);
}

export async function readQuantityPlanningSettings() {
  return quantityPlanningServer().readSettings();
}

export async function saveQuantityPlanningSettings(request: QuantityPlanningSettingsSaveRequest) {
  return quantityPlanningServer().saveSettings(request);
}
