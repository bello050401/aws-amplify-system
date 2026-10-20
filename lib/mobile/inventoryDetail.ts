import {mergedInventoryTarget} from "@/lib/outbound/mergeInventory";
import {unconvertedZaicoValues} from "@/lib/zaico/transition/rawValues";
import {categoryLabels} from '@/lib/inventory/categories';
import type { InventoryDetail, MasterOption, StatusOption } from "@/lib/inventory/queries";
import { visibleDetailFields } from "@/mobile/src/domain/detailFields";
import type { MobileFeatures } from "./accessPolicy";
import type { InventoryItem, InventoryPhoto } from "@/mobile/src/domain/inventory";

const fieldText = (value: unknown): string => typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";

/** An explicit projection; raw custom fields, provider data and denied features never leave this boundary. */
export function mobileInventoryDetail(row: InventoryDetail, categories: MasterOption[], locations: MasterOption[], statuses: StatusOption[], features: MobileFeatures, photos: InventoryPhoto[], fetchedAt: string): InventoryItem {
  const details = Object.fromEntries(visibleDetailFields(features).map(field => [field.key,
    fieldText(field.custom ? row.customFields?.[field.key] : row[field.key]),
  ]));
  return {
    mergedIntoInventoryId: mergedInventoryTarget(row.customFields),
    id: row.id, sku: row.sku, displayId: row.displayId, name: row.name, quantity: row.quantity, unit: row.unit ?? "",
    quantityUnset:row.quantityUnset,
    zaicoOriginalValues:unconvertedZaicoValues(row.customFields).filter(value=>visibleDetailFields(features).some(field=>(field.custom?`custom.${field.key}`:field.key)===value.field)).map(({field,name,value})=>({field,name,value})),
    location: locations.find(location => location.id === row.locationId)?.name ?? "",
    category: categoryLabels(row,categories).join(","),
    // Reuse BELLO's existing state/master relationship. No app-only ZAICO state field.
    statusId: row.statusId,
    statusOptions: statuses.map(status => ({ id: status.id, label: status.label })),
    categoryOptions: categories.map(option => option.name), locationOptions: locations.map(option => option.name),
    condition: statuses.find(status => status.id === row.statusId)?.label ?? "", note: row.note ?? "", barcode: row.barcode ?? "",
    plannedSalePrice: row.plannedSalePrice, thumbnailUrl: photos.find(photo => photo.primary)?.url ?? photos[0]?.url ?? null,
    createdAt: row.createdAt, updatedAt: row.updatedAt, details, photos, detailLoadedAt: fetchedAt,
  };
}
