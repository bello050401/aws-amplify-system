/** Diagnostic values are fixed labels. Never pass Error.message, stack, URLs,
 * form fields, object snapshots, inventory values or customer information. */
export const SYSTEM_ERROR_CODES = ["UI_RENDER_FAILED", "UI_UNHANDLED", "API_SERVER_ERROR", "SERVER_REQUEST_FAILED", "PROCUREMENT_FETCH_FAILED", "PROCUREMENT_ENRICH_FAILED", "PROCUREMENT_REGISTER_FAILED"] as const;
export const SYSTEM_ERROR_SURFACES = ["web", "native", "server"] as const;
export const SYSTEM_ERROR_OPERATIONS = ["render", "request", "fetch", "enrich", "register"] as const;
export const SYSTEM_ERROR_COMPONENTS = ["app", "inventory", "procurement-yahoo", "procurement-trefac", "procurement-restage", "staff-app"] as const;
export const SYSTEM_ERROR_CLASSES = ["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "Unknown"] as const;
export type SystemErrorSignal = {
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
    ...((SYSTEM_ERROR_CLASSES as readonly unknown[]).includes(v.errorClass) && {errorClass: v.errorClass}),
    ...(typeof v.digest === "string" && /^\d{1,20}$/.test(v.digest) && {digest: v.digest}),
  } as SystemErrorSignal;
}
