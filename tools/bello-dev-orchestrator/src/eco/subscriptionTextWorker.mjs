import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { runProcess, localEnvironment, writeEvidence } from "../pipeline/process.mjs";
import { reasoningEffortArg, restrictedCodexArgs } from "../runner/codexOptions.mjs";
import { parseCliResult } from "./modelEvaluation.mjs";

// Text-only GPT worker: no browser capability and no claim of performing QA.
// The host supplies the schema, prompt and artifact validation; the Agent cannot
// select its model, enable tools, approve an operation or update model evidence.
export function subscriptionTextWorker({
  model,
  reasoningEffort,
  selectionReason,
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
  const effort = reasoningEffort ?? "low";
  const effortArg = reasoningEffortArg(effort, model);
  const selection = { provider: "codex", model, reasoningEffort: effort, reason: selectionReason || "Host worker settings" };
  fs.mkdirSync(directory, { recursive: true });
  const binding = crypto
    .createHash("sha256")
    .update(JSON.stringify({ model, schema, ...(effort !== "low" ? { reasoningEffort: effort } : {}), ...(imagesForContext ? { vision: true } : {}) }))
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
    reasoningEffort: effort,
    reconcile: async (context) => read(context),
    execute: async (context) => {
      if (
        context.selection &&
        (context.selection.model !== model ||
          context.selection.provider !== "codex" ||
          (context.selection.reasoningEffort ?? effort) !== effort)
      )
        return { status: "blocked", reason: "Exact worker model mismatch" };
      const old = read(context);
      if (old.status !== "absent") return old;
      const login = await assertSubscription();
      if (login !== true && login?.ok !== true)
        return {
          status: "auth",
          reason: login?.reason || "Verified ChatGPT subscription authentication required",
          effectCompleted: true,
          model: selection,
        };
      const prompt = await buildPrompt(context);
      const promptBytes = Buffer.byteLength(prompt, "utf8");
      if (promptBytes > 12000) throw Error("Text worker prompt exceeds the bounded host input size");
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
          selection: context.selection || selection,
          promptBytes,
          images: images.map(file => ({ file, digest: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') })),
          at: new Date().toISOString(),
        }),
        { flag: "wx" },
      );
      const args = [
        "exec",
        ...restrictedCodexArgs("read-only"),
        "--model",
        model,
        "-c",
        "features.shell_tool=false",
        "-c",
        effortArg,
        "--skip-git-repo-check",
        "--cd",
        f.root,
        "--output-schema",
        schemaFile,
        "--output-last-message",
        outputFile,
      ];
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
      writeEvidence(f.root, "cli.json", result);
      const parsed = parseCliResult(
        "codex",
        result,
        fs.existsSync(outputFile) && fs.statSync(outputFile).size <= 1024 * 1024 ? fs.readFileSync(outputFile, "utf8") : "",
      );
      const usage = {
        measuredTokens: parsed.totalTokens ?? 0,
        estimatedTokens: parsed.totalTokens === null || parsed.totalTokens === undefined
          ? Math.ceil((promptBytes + Buffer.byteLength(JSON.stringify(parsed.answer ?? ""))) / 3)
          : 0,
        costUsd: 0,
        costKnown: false,
      };
      let receipt;
      if (!parsed.ok) {
        receipt = {
          status: parsed.providerStatus || "blocked",
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
      receipt.usage = usage;
      receipt.model = context.selection || selection;
      fs.writeFileSync(f.receipt + ".tmp", JSON.stringify(receipt), {
        flag: "wx",
      });
      fs.renameSync(f.receipt + ".tmp", f.receipt);
      return receipt;
    },
  };
}
