import { reportServerSystemError } from './server';
import type { FeatureComponent, FeatureOperation } from './feature';
import type { FeatureCheck } from './health';

/** Delivery failure cannot change the result of a user's read/export request. */
export async function reportFeatureChecks(component: FeatureComponent, operation: FeatureOperation, checks: readonly FeatureCheck[]): Promise<void> {
  for (const check of new Set(checks)) {
    try { await reportServerSystemError({code:'FEATURE_INVARIANT_FAILED',surface:'server',component,operation,check}); }
    catch { /* A later observation can retry through the deduplicated queue. */ }
  }
}
