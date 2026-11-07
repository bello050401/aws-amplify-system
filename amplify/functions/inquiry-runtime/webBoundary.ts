// Lambda has no signed-in browser. Do not impersonate an employee or permit cookie-only mutations.
// Inventory readers fall back to the existing direct data client, constrained by this worker's read-only IAM grants.
export async function inventoryVerifiedReadSession() { return null; }
export async function inventoryMutationSession() { return null; }
export async function runWithAmplifyServerContext(): Promise<never> { throw Error("BROWSER_SESSION_REQUIRED"); }
