/** Exact public exceptions; never exempt an entire /api namespace. */
const publicRoutes = new Set([
  "/api/mobile/config", "/api/line/webhook", "/api/line/notify-webhook",
]);
export function protectedBusinessPath(path: string) {
  if (["/inventory/login", "/admin/login"].includes(path) || path.startsWith("/api/security/") || publicRoutes.has(path)) return false;
  return path === "/inventory" || path.startsWith("/inventory/") || path === "/admin" || path.startsWith("/admin/") || path.startsWith("/api/");
}
