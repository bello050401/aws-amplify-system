/** Mirrors the production CI preflight in scripts/check-security-release.cjs. */
export const REQUIRED_CUTOVER_CHECKS = [
  "productionUsersPreserved", "legacyGroupsPreserved", "allBusinessRoutesGated",
  "appSyncDirectAccessDenied", "apiKeyPrivateDataDenied", "identityPoolDirectAccessDenied",
  "s3ExistingUrlExpiryBounded", "photoStationMachineAuthVerified", "oauthCallbacksVerified",
  "backgroundWorkersVerified", "adminRecoveryRehearsed", "rollbackRehearsed",
  "realIPhonePasskeyPassed", "realWindowsHelloPassed", "sessionReopenPassed",
  "revocationOnRealBusinessApiPassed", "businessRegressionPassed", "auditAlertRecipientVerified", "trustedClientIpVerified",
] as const;
export type CutoverCheck = typeof REQUIRED_CUTOVER_CHECKS[number];
export type CutoverEvidence = Partial<Record<CutoverCheck, { passed: boolean; evidence: string }>>;
export function cutoverReadiness(evidence: CutoverEvidence) {
  const missing = REQUIRED_CUTOVER_CHECKS.filter(k => evidence[k]?.passed !== true || !evidence[k]?.evidence?.trim());
  return { ready: missing.length === 0, missing };
}
export function assertCutoverReady(evidence: CutoverEvidence) {
  const result = cutoverReadiness(evidence);
  if (!result.ready) throw new Error("SECURITY_CUTOVER_BLOCKED: " + result.missing.join(","));
}
