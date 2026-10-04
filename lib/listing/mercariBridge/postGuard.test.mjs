import assert from "node:assert/strict";
import test from "node:test";
import { bridgePostHeaderFailure } from "./postGuard.ts";

const publicOrigin = "https://bello.example.test";
const input = overrides => ({ origin: publicOrigin, requestOrigin: "http://internal-host:3000",
  configuredPublicOrigin: publicOrigin, contentType: "application/json", hasNextAction: false,
  ...overrides });

test("trusted public HTTPS origin works behind an internal Amplify URL", () => {
  assert.equal(bridgePostHeaderFailure(input()), null);
  assert.equal(bridgePostHeaderFailure(input({ requestOrigin: publicOrigin,
    configuredPublicOrigin: undefined })), null);
});

test("foreign or missing origin, unsupported content type, and Next action remain blocked", () => {
  assert.equal(bridgePostHeaderFailure(input({ origin: "https://evil.example.test" })), "ORIGIN_MISMATCH");
  assert.equal(bridgePostHeaderFailure(input({ origin: null })), "ORIGIN_MISMATCH");
  assert.equal(bridgePostHeaderFailure(input({ configuredPublicOrigin: "http://bello.example.test" })),
    "ORIGIN_MISMATCH");
  assert.equal(bridgePostHeaderFailure(input({ contentType: "text/plain" })), "CONTENT_TYPE_INVALID");
  assert.equal(bridgePostHeaderFailure(input({ hasNextAction: true })), "NEXT_ACTION_FORBIDDEN");
});
