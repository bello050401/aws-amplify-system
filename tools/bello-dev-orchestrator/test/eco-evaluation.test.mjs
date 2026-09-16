import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluateAnswer,
  parseCliResult,
  summarizeTrials,
} from "../src/eco/modelEvaluation.mjs";
import { subscriptionTextWorker } from "../src/eco/subscriptionTextWorker.mjs";
test("independent scoring rejects nested serialization and extra fields", () => {
  assert.equal(evaluateAnswer({ expected: "x" }, { answer: "x" }).passed, true);
  assert.equal(
    evaluateAnswer({ expected: "x" }, { answer: '{"answer":"x"}' }).passed,
    false,
  );
  assert.equal(
    evaluateAnswer({ expected: "x" }, { answer: "x", passed: true }).passed,
    false,
  );
});
test("provider usage keeps caches explicit and never doubles Codex cached inputs", () => {
  const codex = parseCliResult(
    "codex",
    {
      ok: true,
      stdout: JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 80,
          output_tokens: 10,
        },
      }),
    },
    '{"answer":"x"}',
  );
  assert.equal(codex.totalTokens, 110);
  const claude = parseCliResult("claude", {
    ok: true,
    stdout: JSON.stringify({
      structured_output: { answer: "x" },
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
      },
    }),
  });
  assert.equal(claude.totalTokens, 10);
  assert.equal(
    parseCliResult("claude", {
      ok: true,
      stdout: '{"is_error":true,"api_error_status":429}',
    }).capacity,
    true,
  );
});
test("small pilots cannot manufacture independent sample counts", () => {
  const trial = {
    id: "one",
    provider: "claude",
    model: "fixture",
    category: "mechanical_edit",
    invocations: 1,
    passed: true,
    totalTokens: 10,
    durationMs: 100,
    promptHash: "a",
    expectedHash: "b",
  };
  const args = {
    provider: "claude",
    model: "fixture",
    category: "mechanical_edit",
    baselineModel: "fixture",
    baselinePassRate: 1,
    trials: [trial],
  };
  assert.equal(summarizeTrials(args).pilotOnly, true);
  assert.equal(summarizeTrials(args).samples, 1);
  assert.throws(() => summarizeTrials({ ...args, trials: [trial, trial] }));
  assert.throws(() =>
    summarizeTrials({ ...args, trials: [{ ...trial, invocations: 3 }] }),
  );
});
test("text worker passes exact model, restricts tools, persists outcome across restart", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "bello-text-worker-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const config = {
    model: "fixture",
    executable: "fixture.exe",
    directory,
    schema: { type: "object" },
    assertSubscription: async () => true,
    buildPrompt: async () => "fixture",
    makeArtifact: async (answer) => ({ kind: "spec", body: answer }),
    execute: async (args) => {
      calls++;
      assert.equal(args.args[args.args.indexOf("--model") + 1], "fixture");
      assert.ok(args.args.includes("features.shell_tool=false"));
      assert.equal(args.env.OPENAI_API_KEY, undefined);
      fs.writeFileSync(
        args.args[args.args.indexOf("--output-last-message") + 1],
        '{"answer":"x"}',
      );
      return {
        ok: true,
        stdout: JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
      };
    },
  };
  const context = {
    run: { id: "run" },
    operationKey: "one",
    selection: { provider: "codex", model: "fixture" },
  };
  const first = await subscriptionTextWorker(config).execute(context);
  assert.equal(first.status, "succeeded");
  assert.deepEqual(
    await subscriptionTextWorker(config).reconcile(context),
    first,
  );
  assert.deepEqual(
    await subscriptionTextWorker(config).execute(context),
    first,
  );
  assert.equal(calls, 1);
  assert.equal(
    (
      await subscriptionTextWorker(config).execute({
        ...context,
        selection: { provider: "codex", model: "wrong" },
      })
    ).status,
    "blocked",
  );
});
test("text worker never repeats interrupted dispatch and cannot advertise browser QA", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "bello-text-worker-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const config = {
    model: "fixture",
    executable: "fixture",
    directory,
    schema: {},
    assertSubscription: async () => true,
    buildPrompt: async () => "fixture",
    makeArtifact: async () => ({}),
    execute: async () => {
      calls++;
      throw Error("interrupted");
    },
  };
  const context = { run: { id: "run" }, operationKey: "one" };
  const worker = subscriptionTextWorker(config);
  assert.deepEqual(worker.capabilities, ["text"]);
  await assert.rejects(worker.execute(context));
  assert.equal(
    (await subscriptionTextWorker(config).execute(context)).status,
    "unknown",
  );
  assert.equal(calls, 1);
});

test("image evidence is host bounded and never grants browser capability", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bello-vision-worker-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const screenshot = path.join(directory, "screen.png");
  fs.writeFileSync(screenshot, "synthetic transport fixture");
  let calls = 0;
  const options = { model: "fixture", executable: "fixture", directory, schema: {},
    assertSubscription: async () => true, buildPrompt: async () => "Inspect supplied evidence",
    makeArtifact: async answer => answer, imagesForContext: async () => [screenshot],
    execute: async ({args}) => { calls++; assert.equal(args[args.indexOf('--image') + 1], screenshot);
      fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], '{"answer":"observed"}');
      return {ok:true,stdout:'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'};
    } };
  const context = {run:{id:'vision'},operationKey:'image-one'};
  const worker = subscriptionTextWorker(options);
  assert.deepEqual(worker.capabilities, ['text','image']);
  assert.equal((await worker.execute(context)).status, 'succeeded');
  assert.equal((await subscriptionTextWorker(options).reconcile(context)).status, 'succeeded');
  await assert.rejects(subscriptionTextWorker({...options,imagesForContext:async()=>['relative.png']}).execute({...context,operationKey:'invalid'}));
  assert.equal(calls, 1);
});
