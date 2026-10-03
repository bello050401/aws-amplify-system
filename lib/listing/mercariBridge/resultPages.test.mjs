import assert from "node:assert/strict";
import test from "node:test";
import { collectReadResultPages } from "./resultPages.ts";

test("result lookup includes later pages even when the index has no time order", async () => {
  const seen = [];
  const rows = await collectReadResultPages(async (token) => {
    seen.push(token);
    return token ? { items: ["newest"] } : { items: ["older"], nextToken: "page-2" };
  });
  assert.deepEqual(seen, [undefined, "page-2"]);
  assert.deepEqual(rows, ["older", "newest"]);
});

test("result lookup fails on a repeated cursor or page cap instead of silently omitting rows", async () => {
  await assert.rejects(collectReadResultPages(async () => ({ items: [], nextToken: "same" })), /cursor repeated/);
  await assert.rejects(collectReadResultPages(async () => ({ items: [], nextToken: "more" }), 1), /safe page limit/);
});
