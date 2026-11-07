import { createDirectDataClient } from "../../../lib/amplify/directData";
import type { serverDataClient as WebClient } from "../../../lib/amplify/dataClient";
// Only the Lambda build aliases this module. Its IAM role is the authorization boundary.
export const serverDataClient =
  createDirectDataClient() as unknown as typeof WebClient;
export const inventoryAuthMode = { authMode: "iam" as const };
export const adminAuthMode = inventoryAuthMode;
export const isDirectDataMode = () => true;
export const runWithDirectData = <T>(fn: () => Promise<T>): Promise<T> => fn();
