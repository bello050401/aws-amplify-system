import { createServerRunner } from "@aws-amplify/adapter-nextjs";
import outputs from "@/amplify_outputs.json";
import { userPoolServerConfig } from "./userPoolServerConfig";

/** Token-only context; use serverUtils for S3/IAM operations. */
export const { runWithAmplifyServerContext: runWithUserPoolServerContext } = createServerRunner({
  config: userPoolServerConfig(outputs),
});
