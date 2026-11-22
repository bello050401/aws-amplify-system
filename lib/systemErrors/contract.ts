/** Diagnostic values are fixed labels. Never pass Error.message, stack, URLs,
 * form fields, object snapshots, inventory values or customer information. */
export const SYSTEM_ERROR_CODES = ["FEATURE_OPERATION_FAILED", "FEATURE_INVARIANT_FAILED", "FEATURE_SLOW_OPERATION", "UI_RENDER_FAILED", "UI_UNHANDLED", "API_SERVER_ERROR", "SERVER_REQUEST_FAILED", "PROCUREMENT_FETCH_FAILED", "PROCUREMENT_ENRICH_FAILED", "PROCUREMENT_REGISTER_FAILED", "SALE_AUTOMATION_FAILED", "SALE_LINK_FAILED", "SALE_EC_UNCONFIRMED", "SALE_DESKTOP_FAILED", "SALE_IMPORT_FAILED", "SALE_AUTH_REQUIRED", "SALE_RATE_LIMITED", "SALE_REMOTE_FORMAT_CHANGED"] as const;
export const SYSTEM_ERROR_SURFACES = ["web", "native", "server"] as const;
export const SYSTEM_ERROR_OPERATIONS = ["search", "export", "aggregate", "share", "render", "request", "fetch", "enrich", "register", "identify", "verify", "adjust", "sell"] as const;
export const SYSTEM_ERROR_COMPONENTS = ["inventory-search", "inventory-images", "partner-sharing", "sales-analysis", "inventory-analysis", "antique-ledger", "app", "inventory", "procurement-yahoo", "procurement-trefac", "procurement-restage", "staff-app", "sale-automation", "sale-desktop", "sale-import"] as const;
export const SYSTEM_ERROR_CLASSES = ["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "Unknown"] as const;
export const SYSTEM_ERROR_CHECKS = ["operation-failed", "slow-response", "image-source-mismatch", "aggregate-total-mismatch", "quantity-total-mismatch", "category-total-mismatch", "export-row-mismatch", "filter-result-mismatch"] as const;
export type SystemErrorSignal = {
  check?: typeof SYSTEM_ERROR_CHECKS[number];
  code: typeof SYSTEM_ERROR_CODES[number];
  surface: typeof SYSTEM_ERROR_SURFACES[number];
  operation: typeof SYSTEM_ERROR_OPERATIONS[number];
  component: typeof SYSTEM_ERROR_COMPONENTS[number];
  errorClass?: typeof SYSTEM_ERROR_CLASSES[number];
  digest?: string;
};
export function normalizeSystemErrorSignal(value: unknown): SystemErrorSignal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!(SYSTEM_ERROR_CODES as readonly unknown[]).includes(v.code) || !(SYSTEM_ERROR_SURFACES as readonly unknown[]).includes(v.surface) || !(SYSTEM_ERROR_OPERATIONS as readonly unknown[]).includes(v.operation) || !(SYSTEM_ERROR_COMPONENTS as readonly unknown[]).includes(v.component)) return null;
  // Deliberately reconstruct; extra properties are never stored or forwarded.
  return {code: v.code, surface: v.surface, operation: v.operation, component: v.component,
    ...((SYSTEM_ERROR_CHECKS as readonly unknown[]).includes(v.check) && {check: v.check}),
    ...((SYSTEM_ERROR_CLASSES as readonly unknown[]).includes(v.errorClass) && {errorClass: v.errorClass}),
    ...(typeof v.digest === "string" && /^\d{1,20}$/.test(v.digest) && {digest: v.digest}),
  } as SystemErrorSignal;
}
