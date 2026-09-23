import { parseFailedRetryIds, resolveDeltaSince } from "./zaicoDelta";

type Job = {
  status?: string | null;
  lastSuccessfulSyncAt?: string | null;
  failedSourceIds?: unknown;
};

/** A scheduled run may only reuse a completed, trustworthy delta baseline. */
export function planScheduledZaicoDelta(job: Job | null): { syncSince: string; failedSourceIds: unknown } | null {
  if (job?.status !== "COMPLETED" || !job.lastSuccessfulSyncAt) return null;
  const syncSince = resolveDeltaSince(job.lastSuccessfulSyncAt);
  if (!syncSince || !parseFailedRetryIds(job.failedSourceIds).trusted) return null;
  return { syncSince, failedSourceIds: job.failedSourceIds };
}
