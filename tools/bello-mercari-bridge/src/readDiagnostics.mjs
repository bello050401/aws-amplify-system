const CODES = new Set([
  "ACCOUNT_MISMATCH", "NAVIGATION_UNVERIFIED", "HEADING_TIMEOUT", "HEADING_NOT_UNIQUE",
  "NEXT_BUTTON_TIMEOUT", "NEXT_BUTTON_NOT_UNIQUE", "DOCUMENT_URL_UNVERIFIED",
  "PAGE_URL_UNVERIFIED", "FIELD_ROWS_INVALID", "TITLE_UNOBSERVED",
  "DESCRIPTION_UNOBSERVED", "INVENTORY_CODE_UNOBSERVED", "PRICE_UNOBSERVED",
]);

/** Local, fixed-code diagnostics only. Never accepts URLs, labels, or field values. */
export function safeReadDiagnostics(input) {
  return Array.isArray(input) ? [...new Set(input.filter(code => CODES.has(code)))].slice(0, 8) : [];
}
