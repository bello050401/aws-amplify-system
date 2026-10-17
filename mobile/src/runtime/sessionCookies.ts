export function nativeSessionCookies(input: { clientId: string; username: string; accessToken: string; idToken: string }): string {
  // Cookie names and values are strictly bounded; raw user input cannot add a header.
  if (![input.clientId, input.username].every((value) => /^[A-Za-z0-9_@.\-]+$/.test(value))) throw new Error("Invalid session identity.");
  if (![input.accessToken, input.idToken].every((value) => /^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/.test(value))) throw new Error("Invalid session token.");
  const prefix = `CognitoIdentityServiceProvider.${input.clientId}`;
  return [
    `${prefix}.LastAuthUser=${encodeURIComponent(input.username)}`,
    `${prefix}.${input.username}.accessToken=${input.accessToken}`,
    `${prefix}.${input.username}.idToken=${input.idToken}`,
  ].join("; ");
}
