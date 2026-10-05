const STAGING_ORIGIN =
  "https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com";

/** The private-create trial journal is opt-in and staging-only. */
export function privateCreateTrialEnabled(enabled: string | undefined,
  publicOrigin: string | undefined) {
  return enabled === "1" && publicOrigin === STAGING_ORIGIN;
}
