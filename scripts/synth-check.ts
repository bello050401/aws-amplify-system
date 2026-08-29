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

  // Amplify Data (Auth/Data/Storage/functions) is provisioned via nested
  // stacks, whose templates are written to disk as separate files in the
  // same cloud assembly directory rather than appearing in
  // `assembly.stacks` — so search the whole synthesized output tree, not
  // just the top-level stack templates.
  const hits = findFilesContaining(assembly.directory, "ZaicoSyncJob");
  if (hits.length === 0) throw new Error(`ZaicoSyncJob was not found in any synthesized template under ${assembly.directory}.`);
  console.log(`✓ Found "ZaicoSyncJob" referenced in ${hits.length} synthesized template file(s):`);
  for (const f of hits) console.log(`  - ${path.relative(assembly.directory, f)}`);

  let totalZaicoJobResources = 0;
  for (const f of hits) {
    const template = JSON.parse(fs.readFileSync(f, "utf8"));
    const matches = Object.keys(template.Resources ?? {}).filter((id) => id.includes("ZaicoSyncJob"));
    totalZaicoJobResources += matches.length;
  }
  console.log(`✓ Total CloudFormation resources whose logical id contains "ZaicoSyncJob": ${totalZaicoJobResources}`);
  if (totalZaicoJobResources === 0) throw new Error("ZaicoSyncJob text was found (e.g. in a GraphQL schema string) but no actual CloudFormation resource for it exists.");
}

main().catch((err) => {
  console.error("synth-check.ts FAILED:", err);
  process.exit(1);
});
