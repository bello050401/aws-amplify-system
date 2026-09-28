import assert from "node:assert/strict";
import { resolveNextEngineTokenRotation } from "../lib/listing/nextEngine/tokenRotation";

const current = { accessToken: "synthetic-old-access", refreshToken: "synthetic-old-refresh" };
assert.deepEqual(resolveNextEngineTokenRotation(current, { result: "success" }), { ...current, rotated: false });
assert.deepEqual(resolveNextEngineTokenRotation(current, { result: "error", code: "synthetic",
  access_token: "synthetic-new-access", refresh_token: "synthetic-new-refresh" }), {
  accessToken: "synthetic-new-access", refreshToken: "synthetic-new-refresh", rotated: true,
});
assert.throws(() => resolveNextEngineTokenRotation(current, { access_token: "synthetic-new-access" }));
assert.throws(() => resolveNextEngineTokenRotation(current, { access_token: "", refresh_token: "synthetic-new-refresh" }));
console.log("Next Engine token rotation: complete pairs preserved even on API errors; partial responses rejected.");
