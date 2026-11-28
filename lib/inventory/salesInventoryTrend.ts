import type { InventoryValueView } from './inventoryValue';
import type { SalesTrendPoint } from './salesViewTypes';

const jstMonth = (date: Date) => new Date(date.getTime() + 9 * 3600_000).toISOString().slice(0, 7);
/** Existing immutable month-end values; only the actual current month may use current. */
export async function inventoryTrendValue(month: string, load: (month?: string) => Promise<InventoryValueView>, now = new Date()): Promise<NonNullable<SalesTrendPoint['inventory']>> {
  const currentMonth = jstMonth(now);
  if (month > currentMonth) return { status: 'missing' };
  const current = month === currentMonth;
  try {
    const view = await load(current ? undefined : month);
    if (view.status !== 'ok') return { status: view.status };
    const { value } = view;
    const asOf = new Date(value.asOf);
    if (!Number.isFinite(asOf.getTime()) || asOf > now || jstMonth(asOf) !== month || (!current && value.month !== month)) return { status: 'error' };
    return { status: 'ok', total: value.total, asOf: value.asOf, source: value.source, current };
  } catch { return { status: 'error' }; }
}

export function inventoryTrendLabel(point: SalesTrendPoint): string {
  const value = point.inventory;
  if (value?.status === 'error') return '在庫金額 取得エラー';
  if (value?.status !== 'ok' || value.total === undefined || !value.asOf) return '在庫金額 データなし';
  const date = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value.asOf));
  return `在庫金額 ¥${value.total.toLocaleString('ja-JP')}（${value.current ? '当月途中' : '月末'}・${date} JST${value.source ? `・${value.source}` : ''}）`;
}

export function inventoryTrendNote(points: SalesTrendPoint[]): string {
  const available = points.filter(p => p.inventory?.status === 'ok');
  const months = available.map(p => `${p.year}/${p.month}`).join('・');
  const current = available.find(p => p.inventory?.current);
  const asOf = current?.inventory?.asOf;
  const date = asOf ? new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }).format(new Date(asOf)) : null;
  return `在庫金額は原価総額。過去月は月末${date ? `、当月は${date}時点` : ''}。${months ? `記録あり：${months}。` : '記録なし。'}記録がない月は非表示。${points.some(p => p.inventory?.status === 'error') ? '取得エラーの月があります。' : ''}`;
}
