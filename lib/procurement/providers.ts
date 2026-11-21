/** Stable source keys shared by staff-app navigation and the existing import panel. */
export const PROCUREMENT_PROVIDERS = [
  { key: 'yahoo', label: 'ヤフーオークション', mobileLabel: 'Yahoo!オークション' },
  { key: 'trefac', label: 'トレファクライブネットオークション', mobileLabel: 'トレファク（業者間オークション）' },
  { key: 'restage', label: 'リステージオークション', mobileLabel: 'Restage（リステージ）' },
] as const;
export type ProcurementProvider = typeof PROCUREMENT_PROVIDERS[number]['key'];
export function procurementProvider(value: unknown): ProcurementProvider {
  return PROCUREMENT_PROVIDERS.some(provider => provider.key === value) ? value as ProcurementProvider : 'restage';
}
export const STAFF_APP_HOME = '/staff-app/index.html';
export function staffProcurementPath(provider: ProcurementProvider): string {
  return '/inventory/procurement?provider=' + procurementProvider(provider) + '&from=staff-app';
}
