import assert from "node:assert/strict";
import { test } from "node:test";
import { privateCreateTrialEnabled } from "./privateCreateGate.ts";

test("private-create journal remains disabled without exact staging opt-in", () => {
  const staging = "https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com";
  assert.equal(privateCreateTrialEnabled(undefined, staging), false);
  assert.equal(privateCreateTrialEnabled("0", staging), false);
  assert.equal(privateCreateTrialEnabled("1", "https://example.com"), false);
  assert.equal(privateCreateTrialEnabled("1", staging), true);
});
