import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { runProcess, localEnvironment } from "../pipeline/process.mjs";
import { parseCliResult } from "./modelEvaluation.mjs";

// Text-only GPT worker: no browser capability and no claim of performing QA.
// The host supplies the schema, prompt and artifact validation; the Agent cannot
// select its model, enable tools, approve an operation or update model evidence.
export function subscriptionTextWorker({
  model,
  executable,
  directory,
  schema,
  buildPrompt,
  makeArtifact,
  assertSubscription,
  imagesForContext = null,
  execute = runProcess,
}) {
  if (!model || !path.isAbsolute(directory) || !assertSubscription)
    throw Error(
      "Explicit model, journal directory and subscription check required",
    );
  fs.mkdirSync(directory, { recursive: true });
  const binding = crypto
    .createHash("sha256")
    .update(JSON.stringify({ model, schema, ...(imagesForContext ? { vision: true } : {}) }))
    .digest("hex");
  const files = (context) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(context.operationKey))
      throw Error("Invalid operation key");
    const root = path.join(directory, context.operationKey);
    return {
      root,
      dispatch: path.join(root, "dispatch.json"),
      receipt: path.join(root, "receipt.json"),
    };
  };
  const read = (context) => {
    const f = files(context);
    if (!fs.existsSync(f.dispatch)) return { status: "absent" };
    const dispatch = JSON.parse(fs.readFileSync(f.dispatch, "utf8"));
    if (dispatch.binding !== binding || dispatch.runId !== context.run.id)
      return { status: "blocked", reason: "Worker operation binding mismatch" };
    return fs.existsSync(f.receipt)
      ? JSON.parse(fs.readFileSync(f.receipt, "utf8"))
      : {
          status: "unknown",
          reason:
            "Previous CLI dispatch has no durable outcome; do not redispatch",
        };
  };
  return {
    capabilities: imagesForContext ? ["text", "image"] : ["text"],
    model,
    reconcile: async (context) => read(context),
    execute: async (context) => {
      if (
        context.selection &&
        (context.selection.model !== model ||
          context.selection.provider !== "codex")
      )
        return { status: "blocked", reason: "Exact worker model mismatch" };
      const old = read(context);
      if (old.status !== "absent") return old;
      if (!(await assertSubscription()))
        return {
          status: "auth",
          reason: "Verified ChatGPT subscription authentication required",
          effectCompleted: false,
        };
      const prompt = await buildPrompt(context);
      const images = imagesForContext ? await imagesForContext(context) : [];
      if (!Array.isArray(images) || images.length > 4 || images.some(file =>
        !path.isAbsolute(file) || !fs.statSync(file).isFile()))
        throw Error("Bounded host-owned image evidence required");
      const f = files(context);
      fs.mkdirSync(f.root, { recursive: true });
      const schemaFile = path.join(f.root, "schema.json"),
        outputFile = path.join(f.root, "answer.json");
      fs.writeFileSync(schemaFile, JSON.stringify(schema), { flag: "wx" });
      fs.writeFileSync(
        f.dispatch,
        JSON.stringify({
          binding,
          runId: context.run.id,
          model,
          images: images.map(file => ({ file, digest: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') })),
          at: new Date().toISOString(),
        }),
        { flag: "wx" },
      );
      const args = [
        "exec",
        "--ignore-user-config",
        "--model",
        model,
        "--sandbox",
        "read-only",
        "-c",
        'approval_policy="never"',
        "-c",
        "features.shell_tool=false",
        "-c",
        'web_search="disabled"',
        "-c",
        'model_reasoning_effort="low"',
        "--ephemeral",
        "--skip-git-repo-check",
        "--json",
        "--color",
        "never",
        "--cd",
        f.root,
        "--output-schema",
        schemaFile,
        "--output-last-message",
        outputFile,
      ];
      if (process.platform === "win32")
        args.push("-c", 'windows.sandbox="elevated"');
      for (const file of images) args.push("--image", file);
      args.push("-");
      const result = await execute({
        file: executable,
        args,
        cwd: f.root,
        env: localEnvironment(),
        input: prompt,
        timeoutMs: 120000,
        shouldStop: context.signal || (() => false),
      });
      fs.writeFileSync(path.join(f.root, "cli.json"), JSON.stringify(result), {
        flag: "wx",
      });
      const parsed = parseCliResult(
        "codex",
        result,
        fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "",
      );
      let receipt;
      if (!parsed.ok) {
        const capacity = /429|usage limit|rate.limit|quota/i.test(
          parsed.reason,
        );
        receipt = {
          status: capacity ? "capacity" : "blocked",
          reason: parsed.reason,
          effectCompleted: true,
        };
      } else if (parsed.unexpectedToolUse)
        receipt = {
          status: "blocked",
          reason: "Text worker attempted unexpected tools",
          effectCompleted: true,
        };
      else {
        const usage = {
          measuredTokens: parsed.totalTokens || 0,
          estimatedTokens: parsed.totalTokens
            ? 0
            : Math.ceil(
                Buffer.byteLength(prompt + JSON.stringify(parsed.answer)) / 3,
              ),
          costUsd: 0,
          costKnown: false,
        };
        try {
          receipt = {
            status: "succeeded",
            artifact: await makeArtifact(parsed.answer, context),
            usage,
          };
        } catch (error) {
          // The model completed a real read-only answer; only the host-side
          // artifact shape/scope check failed. Typed so the engine can bound
          // and auto-regenerate this instead of treating it as an unknown
          // external effect or a communication failure.
          receipt = {
            status: "failed",
            reason: "Host artifact validation: " + error.message,
            effectCompleted: true,
            artifactInvalid: true,
            usage,
          };
        }
      }
      fs.writeFileSync(f.receipt + ".tmp", JSON.stringify(receipt), {
        flag: "wx",
      });
      fs.renameSync(f.receipt + ".tmp", f.receipt);
      return receipt;
    },
  };
}
