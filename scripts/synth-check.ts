/**
 * BELLO統合改修 master指示書: standalone CDK-synth-equivalent check for
 * the Amplify Gen2 backend definition (amplify/backend.ts +
 * amplify/data/resource.ts), run without any real AWS credentials or the
 * `ampx` CLI. This exercises exactly the same construct tree
 * `ampx sandbox`/`ampx pipeline-deploy` would build before ever touching
 * AWS - if this throws, deployment would fail for the same reason. It
 * does NOT call any AWS API and does NOT require credentials; the CDK
 * context values below (amplify-backend-namespace/name/type) are the
 * same three keys `ampx` itself injects before constructing the backend
 * (see @aws-amplify/backend's default_stack_factory.js /
 * backend_identifier.js) - normally supplied by the CLI, supplied here
 * directly via CDK_CONTEXT_JSON so the backend module can be imported
 * standalone.
 *
 * Run via scripts/with-server-only-stub.cjs (backend.ts transitively
 * imports lib/zaico/secretStore.ts and other `server-only` modules).
 */
import * as fs from "node:fs";
import * as path from "node:path";

// The three CDK context keys @aws-amplify/backend's defineBackend()
// requires (see default_stack_factory.js / backend_identifier.js) —
// normally injected by the `ampx` CLI before it ever imports
// amplify/backend.ts, so importing that file standalone (no `ampx`, no
// AWS credentials) needs them supplied some other way. Namespace/name
// here are arbitrary placeholders (this script never deploys anything —
// it only builds the same construct tree `ampx` would and inspects the
// resulting CloudFormation JSON in-memory/on a throwaway temp dir), and
// "sandbox" is the least environment-coupled of the three valid
// deploymentType values. Set only if not already provided by the caller.
process.env.CDK_CONTEXT_JSON ??= JSON.stringify({
  "amplify-backend-namespace": "synth-check",
  "amplify-backend-name": "synth-check",
  "amplify-backend-type": "sandbox",
});

import { App } from "aws-cdk-lib";

/** Recursively walks the synthesized cloud assembly directory (this is where Amplify Data's nested-stack templates for the AppSync API/DynamoDB tables actually live — `assembly.stacks` only lists top-level, non-nested stacks). */
function findFilesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      hits.push(...findFilesContaining(full, needle));
    } else if (entry.isFile() && (entry.name.endsWith(".json") || entry.name.endsWith(".template.json"))) {
      const content = fs.readFileSync(full, "utf8");
      if (content.includes(needle)) hits.push(full);
    }
  }
  return hits;
}

/**
 * Collect every logical id a template fragment references via `Ref` or
 * `Fn::GetAtt`. Cross-nested-stack references in CDK always surface in the
 * PARENT template as one nested stack's `Parameters` reading another nested
 * stack's `Outputs.*` through `Fn::GetAtt`, so scanning the parent's nested
 * stack resources is enough to reconstruct the full inter-stack graph.
 */
function collectRefs(node: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(node)) {
    for (const n of node) collectRefs(n, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "Ref" && typeof v === "string") {
        out.add(v);
      } else if (k === "Fn::GetAtt") {
        const target = Array.isArray(v) ? v[0] : v;
        if (typeof target === "string") out.add(target.split(".")[0]);
      } else {
        collectRefs(v, out);
      }
    }
  }
  return out;
}

/**
 * Fail the build if any two Amplify nested stacks reference each other.
 *
 * Why this exists: CDK's own `app.synth()` happily produces a mutually
 * referencing pair of nested stacks — it is CloudFormation, at deploy time,
 * that rejects them. That gap silently broke every staging build from job
 * #30 to #63 (34 consecutive failures) with:
 *
 *   [CloudformationStackCircularDependencyError] The CloudFormation
 *   deployment failed due to circular dependency found between nested
 *   stacks [data7552DF31, function1351588B]
 *
 * while this very script kept reporting "✓ Synth succeeded". The cause was
 * `data` needing `function` (generate-sku is a custom-mutation resolver via
 * `a.handler.function()`) while `function` needed `data` (the worker Lambdas
 * are granted the model tables and receive their names as env vars) — see
 * amplify/functions/pricing-scheduler/resource.ts for the full write-up and
 * the `resourceGroupName: "data"` fix.
 *
 * Detecting it here means the same class of mistake costs one local run
 * instead of a full push → build → 3-minute AWS failure cycle.
 */
function assertNoNestedStackCycles(assemblyDir: string): void {
  const templates = fs.readdirSync(assemblyDir).filter((f) => f.endsWith(".template.json"));

  // The root stack is the one declaring more than one nested stack child.
  let root: { file: string; nested: [string, Record<string, unknown>][] } | undefined;
  for (const file of templates) {
    const template = JSON.parse(fs.readFileSync(path.join(assemblyDir, file), "utf8"));
    const nested = Object.entries(template.Resources ?? {}).filter(
      ([, r]) => (r as { Type?: string }).Type === "AWS::CloudFormation::Stack",
    ) as [string, Record<string, unknown>][];
    if (nested.length > 1) {
      root = { file, nested };
      break;
    }
  }
  if (!root) throw new Error(`No root stack with nested stacks found under ${assemblyDir}.`);

  const nestedIds = new Set(root.nested.map(([id]) => id));
  // CDK emits helper logical ids like "<StackId>NestedStack<StackId>Resource…";
  // map those back onto the nested stack they belong to.
  const normalize = (id: string): string => {
    for (const n of nestedIds) if (id === n || id.startsWith(n)) return n;
    return id;
  };

  const edges = new Map<string, Set<string>>();
  for (const [id, resource] of root.nested) {
    const deps = new Set<string>();
    for (const ref of collectRefs(resource, new Set())) {
      const n = normalize(ref);
      if (nestedIds.has(n) && n !== id) deps.add(n);
    }
    for (const d of ([] as string[]).concat((resource.DependsOn as string[] | string | undefined) ?? [])) {
      const n = normalize(d);
      if (nestedIds.has(n) && n !== id) deps.add(n);
    }
    edges.set(id, deps);
  }

  const cycles: string[][] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (node: string, stack: string[]): void => {
    state.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (state.get(next) === 1) {
        cycles.push([...stack.slice(stack.indexOf(next)), next]);
      } else if (!state.has(next)) {
        visit(next, stack);
      }
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const id of nestedIds) if (!state.has(id)) visit(id, []);

  if (cycles.length > 0) {
    throw new Error(
      `CloudFormation would reject this backend: ${cycles.length} circular dependency/dependencies between nested stacks:\n` +
        cycles.map((c) => `  ${c.join(" -> ")}`).join("\n") +
        `\nResolution: assign the offending function(s) to the stack they depend on using ` +
        `'resourceGroupName' in defineFunction (see amplify/functions/pricing-scheduler/resource.ts).`,
    );
  }

  const edgeCount = [...edges.values()].reduce((n, s) => n + s.size, 0);
  console.log(
    `✓ No nested-stack circular dependencies: ${nestedIds.size} nested stacks, ${edgeCount} inter-stack edges, 0 cycles.`,
  );
}

async function main() {
  const backendModule = await import("../amplify/backend");
  // `backend.ts` doesn't currently export its `backend` const, so fall
  // back to walking up from any stack this module is known to create.
  // Simplest robust handle: amplify/backend.ts exports `zaicoTokenSecret`,
  // whose `.node.root` is the same CDK App as every other resource in
  // this synth (Amplify Gen2 always uses exactly one App instance).
  const anyExport = (backendModule as unknown as { zaicoTokenSecret?: { node?: { root?: App } } }).zaicoTokenSecret;
  const app = anyExport?.node?.root as App | undefined;
  if (!app) throw new Error("Could not locate the CDK App root from amplify/backend.ts's exports.");

  const assembly = app.synth({ force: true });
  const stacks = assembly.stacks;
  console.log(`✓ Synth succeeded: ${stacks.length} top-level stack(s) produced (outdir: ${assembly.directory}).`);
  for (const s of stacks) {
    console.log(`  - ${s.stackName} (${Object.keys(s.template.Resources ?? {}).length} top-level resources, including nested-stack references)`);
  }

  // Must run before the per-model checks below: a cycle here means the
  // backend cannot deploy at all, whatever the individual models look like.
  assertNoNestedStackCycles(assembly.directory);

  // Amplify Data (Auth/Data/Storage/functions) is provisioned via nested
  // stacks, whose templates are written to disk as separate files in the
  // same cloud assembly directory rather than appearing in
  // `assembly.stacks` — so search the whole synthesized output tree, not
  // just the top-level stack templates.
  //
  // Checks every a.model() added by this master指示書 round: Phase A's
  // ZaicoSyncJob and Phase D's ListingDraft/ChannelListing (BELLO統合改修
  // master指示書 Phase D — EC Listing / Mercari Shops連携).
  for (const modelName of ["ZaicoSyncJob", "ListingDraft", "ChannelListing", "MercariApiTokenSecret"]) {
    const hits = findFilesContaining(assembly.directory, modelName);
    if (hits.length === 0) throw new Error(`${modelName} was not found in any synthesized template under ${assembly.directory}.`);

    let totalResources = 0;
    for (const f of hits) {
      const template = JSON.parse(fs.readFileSync(f, "utf8"));
      totalResources += Object.keys(template.Resources ?? {}).filter((id) => id.includes(modelName)).length;
    }
    console.log(`✓ ${modelName}: referenced in ${hits.length} synthesized template file(s), ${totalResources} CloudFormation resource(s) with it in their logical id.`);
    if (totalResources === 0) throw new Error(`${modelName} text was found (e.g. in a GraphQL schema string) but no actual CloudFormation resource for it exists.`);
  }
}

main().catch((err) => {
  console.error("synth-check.ts FAILED:", err);
  process.exit(1);
});
