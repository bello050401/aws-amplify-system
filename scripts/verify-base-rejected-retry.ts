import assert from "node:assert/strict";
import { canRetryRejectedBaseCreate } from "../lib/listing/base/retry";
import { BASE_LISTING_ERROR_LABEL } from "../lib/listing/base/errors";
import type { ChannelListingRecord } from "../lib/listing/types";

const row = (status: ChannelListingRecord["status"], lastError: string | null, externalListingId: string | null = null) =>
  ({ status, lastError, externalListingId }) as ChannelListingRecord;

assert.equal(canRetryRejectedBaseCreate(row("ERROR", BASE_LISTING_ERROR_LABEL.REMOTE_VALIDATION_ERROR)), true);
assert.equal(canRetryRejectedBaseCreate(row("ERROR", BASE_LISTING_ERROR_LABEL.PERMISSION_DENIED)), true);
assert.equal(canRetryRejectedBaseCreate(row("ERROR", BASE_LISTING_ERROR_LABEL.AUTH_FAILED)), true);
assert.equal(canRetryRejectedBaseCreate(row("ERROR", "通信が途切れました")), false);
assert.equal(canRetryRejectedBaseCreate(row("ERROR", "登録後の公開状態を確認できません")), false);
assert.equal(canRetryRejectedBaseCreate(row("ERROR", BASE_LISTING_ERROR_LABEL.REMOTE_VALIDATION_ERROR, "123")), false);
assert.equal(canRetryRejectedBaseCreate(row("PUBLISHING", BASE_LISTING_ERROR_LABEL.REMOTE_VALIDATION_ERROR)), false);
console.log("BASEの明示拒否だけ再試行可能、結果不明と登録済みは停止: 7件合格");
