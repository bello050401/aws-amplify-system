import type { Period } from './types';

const DAY = 86_400_000;
const JST_OFFSET = 9 * 3_600_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export function jstDay(instant: string): string {
  if (!INSTANT.test(instant)) throw new Error('INVALID_INSTANT');
  dateOnly(instant.slice(0, 10));
  const time = Date.parse(instant);
  if (!Number.isFinite(time)) throw new Error('INVALID_INSTANT');
  return new Date(time + JST_OFFSET).toISOString().slice(0, 10);
}

export function dateOnly(value: string): string {
  if (!DATE.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error('INVALID_DATE');
  }
  return value;
}

export function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(dateOnly(day)) + delta * DAY).toISOString().slice(0, 10);
}

export function rollingPeriod(asOf: string, days: 30 | 90): Period {
  const end = jstDay(asOf);
  return { start: shiftDay(end, 1 - days), end, cutoff: asOf, timezone: 'Asia/Tokyo', partial: true };
}

export function requestedPeriod(start: string, end: string, asOf: string): Period {
  dateOnly(start);
  dateOnly(end);
  if (start > end || (Date.parse(end) - Date.parse(start)) / DAY > 3660) throw new Error('INVALID_PERIOD');
  const today = jstDay(asOf);
  const partial = end >= today;
  const cutoff = partial ? asOf : new Date(Date.parse(end) + DAY - JST_OFFSET - 1).toISOString();
  return { start, end, cutoff, timezone: 'Asia/Tokyo', partial };
}

export function monthPeriod(month: string, asOf: string): Period {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('INVALID_MONTH');
  const start = month + '-01';
  const next = new Date(Date.parse(start));
  next.setUTCMonth(next.getUTCMonth() + 1);
  return requestedPeriod(start, shiftDay(next.toISOString().slice(0, 10), -1), asOf);
}

export function recordedDay(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return DATE.test(value) ? dateOnly(value) : jstDay(value);
  } catch {
    return null;
  }
}

/** Date-only source values have JST-day precision. */
export function sourceDay(value: string | null | undefined, asOf: string): string | null {
  const day = recordedDay(value);
  if (!day || day > jstDay(asOf)) return null;
  return DATE.test(value!) || Date.parse(value!) <= Date.parse(asOf) ? day : null;
}

export function sameLengthComparison(a: Period, b: Period): boolean {
  return !a.partial && !b.partial && Date.parse(a.end) - Date.parse(a.start) === Date.parse(b.end) - Date.parse(b.start);
}
