export type BridgePostGuardCode = "ORIGIN_MISMATCH" | "CONTENT_TYPE_INVALID" | "NEXT_ACTION_FORBIDDEN";

function configuredHttpsOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password ? value : null;
  } catch { return null; }
}

/** Amplify may expose an internal Next URL behind its public HTTPS origin. */
export function bridgePostHeaderFailure(input: {
  origin: string | null;
  requestOrigin: string;
  configuredPublicOrigin?: string;
  contentType: string | null;
  hasNextAction: boolean;
}): BridgePostGuardCode | null {
  const publicOrigin = configuredHttpsOrigin(input.configuredPublicOrigin);
  if (!input.origin || (input.origin !== input.requestOrigin && input.origin !== publicOrigin))
    return "ORIGIN_MISMATCH";
  if (!input.contentType?.toLowerCase().startsWith("application/json"))
    return "CONTENT_TYPE_INVALID";
  if (input.hasNextAction) return "NEXT_ACTION_FORBIDDEN";
  return null;
}
