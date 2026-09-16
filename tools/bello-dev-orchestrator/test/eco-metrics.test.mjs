import test from "node:test";
import assert from "node:assert/strict";
import { summarizeEcoMetrics } from "../src/eco/metrics.mjs";

const baseRun = () => ({
  repairCount: 0,
  logicalFailures: 0,
  communicationFailures: 0,
  artifactFailures: 0,
  usage: { measuredTokens: 0, estimatedTokens: 0, costUsd: 0, costKnown: true },
});

test("throws without a run", () => {
  assert.throws(() => summarizeEcoMetrics(null));
});

test("no usage at all is reported as unknown, never as a saved 100%", () => {
  const summary = summarizeEcoMetrics(baseRun());
  assert.equal(summary.tokens.source, "unknown");
  assert.equal(summary.reuse.unknown, true);
  assert.equal(summary.reuse.reusedOperations, null);
});

test("distinguishes measured from estimated token sources", () => {
  const measured = summarizeEcoMetrics({
    ...baseRun(),
    usage: { measuredTokens: 500, estimatedTokens: 0, costUsd: 0.02, costKnown: true },
  });
  assert.equal(measured.tokens.source, "measured");
  assert.equal(measured.tokens.measured, 500);

  const estimated = summarizeEcoMetrics({
    ...baseRun(),
    usage: { measuredTokens: 0, estimatedTokens: 300, costUsd: 0, costKnown: false },
  });
  assert.equal(estimated.tokens.source, "estimated");

  const mixed = summarizeEcoMetrics({
    ...baseRun(),
    usage: { measuredTokens: 100, estimatedTokens: 50, costUsd: 0, costKnown: false },
  });
  assert.equal(mixed.tokens.source, "mixed");
});

test("cost is never presented as billing or quota, and unknown-cost stays unknown", () => {
  const known = summarizeEcoMetrics({
    ...baseRun(),
    usage: { measuredTokens: 10, estimatedTokens: 0, costUsd: 1.23, costKnown: true },
  });
  assert.equal(known.cost.valueUsd, 1.23);
  assert.equal(known.cost.known, true);
  assert.match(known.cost.note, /請求額|quota/);

  const unknown = summarizeEcoMetrics({
    ...baseRun(),
    usage: { measuredTokens: 10, estimatedTokens: 0, costUsd: 0, costKnown: false },
  });
  assert.equal(unknown.cost.known, false);
});

test("rejects negative or non-finite usage values instead of trusting them", () => {
  const summary = summarizeEcoMetrics({
    ...baseRun(),
    usage: { measuredTokens: -5, estimatedTokens: NaN, costUsd: -1, costKnown: true },
  });
  assert.equal(summary.tokens.measured, 0);
  assert.equal(summary.tokens.estimated, 0);
  assert.equal(summary.tokens.source, "unknown");
  assert.equal(summary.cost.valueUsd, 0);
});

test("counts operations per phase and flags duplicate checkpoint records", () => {
  const summary = summarizeEcoMetrics(baseRun(), {
    checkpoints: [
      { phase: "eco:implement", at: "2026-01-01T00:00:00Z" },
      { phase: "eco:implement", at: "2026-01-01T00:00:00Z" },
      { phase: "eco:test", at: "2026-01-01T00:05:00Z" },
    ],
  });
  assert.equal(summary.operations.total, 3);
  assert.deepEqual(summary.operations.phaseCounts, { "eco:implement": 2, "eco:test": 1 });
  assert.deepEqual(summary.operations.duplicateOperations, ["eco:implement"]);
  assert.match(summary.operations.note, /重複/);
});

test("no checkpoints means no duplicates and a null note", () => {
  const summary = summarizeEcoMetrics(baseRun(), { checkpoints: [] });
  assert.equal(summary.operations.total, 0);
  assert.deepEqual(summary.operations.duplicateOperations, []);
  assert.equal(summary.operations.note, null);
});

test("malformed checkpoint entries fall back to an unknown phase bucket", () => {
  const summary = summarizeEcoMetrics(baseRun(), {
    checkpoints: [{}, { phase: 42 }, { phase: "eco:test" }],
  });
  assert.equal(summary.operations.phaseCounts.unknown, 2);
  assert.equal(summary.operations.phaseCounts["eco:test"], 1);
});

test("surfaces repair and failure counters honestly, defaulting to zero only when absent", () => {
  const summary = summarizeEcoMetrics({
    ...baseRun(),
    repairCount: 2,
    logicalFailures: 1,
    communicationFailures: "bad",
    artifactFailures: undefined,
  });
  assert.equal(summary.repair.count, 2);
  assert.equal(summary.repair.logicalFailures, 1);
  assert.equal(summary.repair.communicationFailures, 0);
  assert.equal(summary.repair.artifactFailures, 0);
});
