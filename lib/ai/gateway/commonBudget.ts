import "server-only";
import { randomUUID } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { liveLedgerDeps, type LedgerDeps } from "../budget/ledgerClient";
import { reserveBudget, settleReservation } from "../budget/ledgerCommands";

export const MONTHLY_CAP_JPY = 300;
const UNITS = 10_000;
export class PaidAIBudgetError extends Error {
  readonly code = "PAID_AI_BUDGET_REFUSED";
  constructor(readonly reason: string) { super(`有料AIを停止: ${reason}`); this.name = "PaidAIBudgetError"; }
}
export interface BudgetPricing {
  providerId: string; modelId: string;
  inputUsdPerMillion: number; outputUsdPerMillion: number;
  /** Reviewed upper conversion bound, INCLUDING tax and all billing surcharges. Not spot FX. */
  yenPerUsdUpperBound: number;
  validUntil: string;
}
export interface BudgetConfig {
  baselineVerifiedMonth: string;
  /** Reviewed total already billed/reserved outside this ledger for this month. Never infer zero. */
  priorSpentJPY: number;
  pricing: BudgetPricing[];
}
export interface PaidAttempt { providerId: string; modelId: string; inputTokens: number; maxOutputTokens: number }
export interface PaidReservation { id: string; month: string; amount: number; pricing: BudgetPricing }
export interface BudgetDependencies { ledger: LedgerDeps; config?: BudgetConfig; now?: Date; id?: string }
function monthOf(now: Date): string { return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 7); }
function positive(n: unknown): n is number { return typeof n === "number" && Number.isFinite(n) && n > 0; }
function tokens(n: unknown): n is number { return typeof n === "number" && Number.isSafeInteger(n) && n >= 0; }
function configFromEnvironment(): BudgetConfig | undefined {
  try { return JSON.parse(process.env.AI_BUDGET_CONFIG_JSON ?? "null") ?? undefined; } catch { return undefined; }
}
function charge(p: BudgetPricing, input: number, output: number): number {
  // Round UP; fractional yen must never create unreserved liabilities.
  return Math.ceil(((input * p.inputUsdPerMillion + output * p.outputUsdPerMillion) / 1_000_000) * p.yenPerUsdUpperBound * UNITS);
}
/** Every actual provider attempt (including escalation) needs a fresh reservation. Unknown => denied. */
export async function reservePaidAttempt(input: PaidAttempt, dependencies?: BudgetDependencies): Promise<
  { allowed: true; reservation: PaidReservation } | { allowed: false; reason: string }
> {
  const now = dependencies?.now ?? new Date();
  const config = dependencies?.config ?? configFromEnvironment();
  const month = monthOf(now);
  if (!config || config.baselineVerifiedMonth !== month || !Number.isFinite(config.priorSpentJPY) || config.priorSpentJPY < 0 || config.priorSpentJPY > MONTHLY_CAP_JPY)
    return { allowed: false, reason: "MONTH_BASELINE_UNVERIFIED" };
  const price = Array.isArray(config.pricing) ? config.pricing.find(p => p.providerId === input.providerId && p.modelId === input.modelId) : undefined;
  if (!price || !positive(price.inputUsdPerMillion) || !positive(price.outputUsdPerMillion) || !positive(price.yenPerUsdUpperBound) || !Number.isFinite(Date.parse(price.validUntil)) || Date.parse(price.validUntil) <= now.getTime())
    return { allowed: false, reason: "PRICING_OR_CURRENCY_BOUND_UNVERIFIED" };
  if (!tokens(input.inputTokens) || !tokens(input.maxOutputTokens) || input.maxOutputTokens === 0) return { allowed: false, reason: "TOKEN_BOUND_UNKNOWN" };
  const amount = charge(price, input.inputTokens, input.maxOutputTokens);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MONTHLY_CAP_JPY * UNITS) return { allowed: false, reason: "LIMIT_EXCEEDED" };
  const id = dependencies?.id ?? randomUUID();
  try {
    const result = await reserveBudget(dependencies?.ledger ?? liveLedgerDeps(), { id, month, amount, cap: MONTHLY_CAP_JPY * UNITS, priorSpent: Math.ceil(config.priorSpentJPY * UNITS) });
    return result.ok ? { allowed: true, reservation: { id, month, amount, pricing: { ...price } } } : { allowed: false, reason: result.reason };
  } catch { return { allowed: false, reason: "BUDGET_STORE_UNAVAILABLE" }; }
}
/** Call ONLY on known successful usage; timeout/unknown usage retains the full reservation. */
export async function settlePaidAttempt(reservation: PaidReservation, usage: { inputTokens: number; outputTokens: number }, dependencies?: Pick<BudgetDependencies, "ledger">): Promise<boolean> {
  if (!tokens(usage.inputTokens) || !tokens(usage.outputTokens)) return false;
  const amount = charge(reservation.pricing, usage.inputTokens, usage.outputTokens);
  if (!Number.isSafeInteger(amount)) return false;
  try {
    // If a provider violated its bound, record the overrun honestly; remaining becomes negative.
    const result = await settleReservation(dependencies?.ledger ?? liveLedgerDeps(), { id: reservation.id, actualAmount: amount });
    return result.ok;
  } catch { return false; }
}
/** Attempt count includes reserved calls interrupted before their response; it is conservative. */
export async function readBudgetSummary(dependencies?: Pick<BudgetDependencies, "ledger" | "now">) {
  const ledger = dependencies?.ledger ?? liveLedgerDeps();
  const month = monthOf(dependencies?.now ?? new Date());
  const result = await ledger.ddb.send(new GetCommand({ TableName: ledger.tableFor("AIBudgetLedger"), Key: { month }, ConsistentRead: true }));
  if (!result.Item) return { month, initialized: false as const };
  const row = result.Item;
  return { month, initialized: true as const, capJPY: row.cap / UNITS, spentJPY: row.spent / UNITS, reservedJPY: row.reserved / UNITS, remainingJPY: row.remaining / UNITS, callCount: row.callCount };
}
