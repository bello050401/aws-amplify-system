export function formatQuantity(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat("ja-JP").format(value);
}

export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return `¥${new Intl.NumberFormat("ja-JP").format(value)}`;
}

export function displayOrDash(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}
