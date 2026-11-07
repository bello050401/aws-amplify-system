import outputs from "@/amplify_outputs.json";

export type RuntimeConfig = { region: string; table: string; queueUrl: string };
export function runtimeConfig(): RuntimeConfig {
  if (process.env.INQUIRY_TABLE && process.env.QUEUE_URL) return {
    region: process.env.AWS_REGION || "us-west-2", table: process.env.INQUIRY_TABLE, queueUrl: process.env.QUEUE_URL,
  };
  const c = (outputs as unknown as { custom?: { inquiryRuntime?: RuntimeConfig } }).custom?.inquiryRuntime;
  if (!c?.table || !c.queueUrl) throw Error("問い合わせの受信処理が未設定です。");
  return c;
}
