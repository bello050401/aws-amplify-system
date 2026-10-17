export interface DateParts { year: number; month: number; day: number }
export function daysInMonth(year: number, month: number) { return new Date(year, month, 0).getDate(); }
export function validDateParts(value: DateParts): DateParts {
  const month = Math.min(12, Math.max(1, value.month));
  return { year: value.year, month, day: Math.min(daysInMonth(value.year, month), Math.max(1, value.day)) };
}
export function dateParts(value: string, now = new Date()): DateParts {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  return match ? validDateParts({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }) : { year: now.getFullYear(), month: now.getMonth()+1, day: now.getDate() };
}
export function dateValue(parts: DateParts) {
  const date = validDateParts(parts);
  return `${date.year}-${String(date.month).padStart(2,"0")}-${String(date.day).padStart(2,"0")}`;
}
