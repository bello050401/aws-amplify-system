import assert from "node:assert/strict";
import { assertNextEngineServerRuntime } from "../lib/listing/nextEngine/serverBoundary";

assert.doesNotThrow(assertNextEngineServerRuntime);
const savedWindow = (globalThis as { window?: unknown }).window;
try {
  (globalThis as { window?: unknown }).window = {};
  assert.throws(assertNextEngineServerRuntime, /サーバー側/);
} finally {
  if (savedWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = savedWindow;
}
console.log("Next Engine API clients reject browser execution.");
