import { SQSClient, ChangeMessageVisibilityCommand } from "@aws-sdk/client-sqs";
import type { SQSEvent, SQSBatchResponse } from "aws-lambda";
import { runInquiry } from "../../../lib/inquiry/runtime/worker";
import { pollInquiryMail } from "../../../lib/inquiry/runtime/mailPoll";
import { resumePending } from "../../../lib/inquiry/runtime/resume";
import {runCustomerDelivery} from '../../../lib/inquiry/runtime/deliveryJobs';
const sqs = new SQSClient({});
// Processing runs in this private Lambda, independent of the website request timeout.
export async function handler(
  event: SQSEvent | { action: "POLL" },
): Promise<SQSBatchResponse> {
  if ("action" in event && event.action === "POLL") {
    try { await pollInquiryMail(); }
    catch (error) {
      console.warn("INQUIRY_MAIL_RETRY", safeErrorCode(error));
      // Lambda logs uncaught Error.message. Never pass provider/customer content.
      throw Error("INQUIRY_MAIL_RETRY");
    }
    return { batchItemFailures: [] };
  }
  if (!("Records" in event)) throw Error("INVALID_JOB");
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const parsed = JSON.parse(record.body);
      if(parsed.action==='SEND'){await runCustomerDelivery(parsed.pk);continue;}
      if (parsed.action === "RESUME") {
        await resumePending(parsed.cursor);
        continue;
      }
      if (parsed.action === "POLL") {
        await pollInquiryMail();
        continue;
      }
      if (
        typeof parsed.pk !== "string" ||
        !/^CONV#[a-f0-9]{64}$/.test(parsed.pk)
      )
        throw Error("INVALID_JOB");
      const result = await runInquiry(parsed.pk);
      if (result.retrySeconds) {
        await sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: process.env.QUEUE_URL,
            ReceiptHandle: record.receiptHandle,
            VisibilityTimeout: Math.min(60, Math.max(1, result.retrySeconds)),
          }),
        );
        failures.push({ itemIdentifier: record.messageId });
      }
    } catch (error) {
      failures.push({ itemIdentifier: record.messageId });
      console.warn("INQUIRY_RETRY", safeErrorCode(error));
    }
  }
  return { batchItemFailures: failures };
}

function safeErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return ["AccessDeniedException", "ValidationException", "ResourceNotFoundException",
    "ConditionalCheckFailedException", "ThrottlingException", "TimeoutError"].includes(name)
    ? name : "PROCESSING_FAILED";
}
