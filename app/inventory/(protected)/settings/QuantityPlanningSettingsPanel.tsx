"use client";

import { readQuantityPlanningSettings, saveQuantityPlanningSettings } from "@/app/actions/inventoryQuantityPlanning";
import { QuantityPlanningSettings } from "@/components/inventory/quantityPlanning/QuantityPlanningSettings";

const ports = { read: readQuantityPlanningSettings, save: saveQuantityPlanningSettings };

export function QuantityPlanningSettingsPanel() {
  return <QuantityPlanningSettings ports={ports} />;
}
