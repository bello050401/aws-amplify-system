import { defineFunction } from "@aws-amplify/backend";

/**
 * Issues the next BELLO SKU (spec: `B000001`, `B000002`, ...).
 *
 * Why a Lambda instead of "read the current max SKU and +1" (explicitly
 * ruled out): that read-then-write has a race window — two concurrent
 * registrations can both read the same max and both write the same next
 * SKU. This handler instead does a single atomic DynamoDB `ADD` on a
 * one-row counter item (see amplify/backend.ts for the table), which
 * DynamoDB guarantees is race-free even under concurrent invocations —
 * no locking, retry loop, or second table read required. See handler.ts.
 */
export const generateSku = defineFunction({
  name: "generate-sku",
  entry: "./handler.ts",
});
