// Only the private worker build uses this module. Generated web outputs do not exist during backend synthesis.
export function runtimeConfig() {
  if (!process.env.INQUIRY_TABLE || !process.env.QUEUE_URL) throw Error("INQUIRY_CONFIG_MISSING");
  return { region: process.env.AWS_REGION || "us-west-2", table: process.env.INQUIRY_TABLE, queueUrl: process.env.QUEUE_URL };
}
