import { reportServerSystemError } from './server';
import { safeErrorClass } from './client';
import type { SystemErrorSignal } from './contract';
export type FeatureComponent = Extract<SystemErrorSignal['component'], 'inventory-search' | 'inventory-images' | 'partner-sharing' | 'sales-analysis' | 'inventory-analysis' | 'antique-ledger'>;
export type FeatureOperation = Extract<SystemErrorSignal['operation'], 'search' | 'export' | 'aggregate' | 'share' | 'fetch' | 'adjust' | 'register'>;
import { isExpectedFeatureError } from './expectedFeature';
export { isExpectedFeatureError } from './expectedFeature';
export async function reportFeatureError(error: unknown, component: FeatureComponent, operation: FeatureOperation): Promise<boolean> {
  try {
    if (isExpectedFeatureError(error)) return false;
    return await reportServerSystemError({code:'FEATURE_OPERATION_FAILED', check:'operation-failed', surface:'server', component, operation, errorClass:safeErrorClass(error)}); }
  catch { return false; }
}
/** Preserve original behavior, even if diagnostic delivery fails. Only successful
 * operations are timed; no duration or business value is forwarded. */
export async function observeFeatureOperation<T>(component: FeatureComponent, operation: FeatureOperation, run: () => Promise<T>, options: {slowMs?: number; now?: () => number; reportFailure?: boolean; successful?: (result: T) => boolean} = {}): Promise<T> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  let result: T;
  try { result = await run(); }
  catch (error) { if (options.reportFailure !== false) await reportFeatureError(error, component, operation); throw error; }
  const threshold = options.slowMs ?? 10000;
  if ((options.successful?.(result) ?? true) && Number.isFinite(threshold) && threshold > 0 && now() - started > threshold) {
    try { await reportServerSystemError({code:'FEATURE_SLOW_OPERATION',check:'slow-response',surface:'server',component,operation}); } catch { /* best effort */ }
  }
  return result;
}
