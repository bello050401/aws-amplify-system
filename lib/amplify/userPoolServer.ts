import { createServerRunner } from "@aws-amplify/adapter-nextjs";
import outputs from "@/amplify_outputs.json";
import { userPoolServerConfig } from "./userPoolServerConfig";
import { deviceSecurityEnabled } from "../security/serverRuntime";
import { businessCookies } from "../security/serverSession";

/** Token-only context; use serverUtils for S3/IAM operations. */
const { runWithAmplifyServerContext: runner } = createServerRunner({
  config: userPoolServerConfig(outputs),
});
export const runWithUserPoolServerContext: typeof runner = input => runner(deviceSecurityEnabled()
  ? { ...input, nextServerContext: { cookies: businessCookies } } : input);
