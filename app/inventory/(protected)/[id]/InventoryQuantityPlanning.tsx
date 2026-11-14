"use client";

import {
  calculateInventoryQuantityPlan, readQuantityPlanning, saveInventoryQuantityPlan,
} from "@/app/actions/inventoryQuantityPlanning";
import { QuantityPlanningPanel } from "@/components/inventory/quantityPlanning/QuantityPlanningPanel";
import { settingsPath } from "@/lib/inventory/quantityPlanning/presentation";
import { InventoryThumbnail } from "../../InventoryThumbnail";

const ports = {
  read: readQuantityPlanning,
  calculate: calculateInventoryQuantityPlan,
  save: saveInventoryQuantityPlan,
};

export function InventoryQuantityPlanning({ inventoryId, version, editHref, admin, storageKey, imageUrl, title }: {
  inventoryId: string;
  version: string | null;
  editHref?: string;
  admin: boolean;
  storageKey: string | null;
  imageUrl: string | null;
  title: string;
}) {
  return <QuantityPlanningPanel key={inventoryId} inventoryId={inventoryId} version={version ?? undefined}
    ports={ports} canWrite={!!editHref} editHref={editHref} settingsHref={admin ? settingsPath : undefined}
    image={storageKey || imageUrl ? <InventoryThumbnail storageKey={storageKey} directUrl={imageUrl} alt={title} size="list" loading="eager" /> : undefined} />;
}
