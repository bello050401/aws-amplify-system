// Two published Amplify construct bundles omit an exact dependency declared by
// their bundled OpenTelemetry children. npm treats it as already present, so
// the lockfile alone cannot make a clean install resolve the requested version.
const { cpSync, existsSync, mkdirSync, readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const installed = path.join(root, "node_modules");
const parents = [
  ["data-construct", "1.17.7"],
  ["graphql-api-construct", "1.22.2"],
];
const readPackage = dir => JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
let repaired = 0;

for (const [parentName, parentVersion] of parents) {
  const parentDir = path.join(installed, "@aws-amplify", parentName);
  if (!existsSync(parentDir)) continue; // npm --omit=dev has no backend constructs.
  const semver = require("semver");
  if (readPackage(parentDir).version !== parentVersion)
    throw Error(`Unexpected Amplify bundle version: ${parentName}`);
  const parentRequire = createRequire(path.join(parentDir, "package.json"));
  // The cloud-assembly-api declared in the bundle is absent from its tarball.
  // npm resolves a newer shared physical package; validate its own ranges.
  const cdkDir = path.dirname(parentRequire.resolve("@aws-cdk/cloud-assembly-api/package.json"));
  const cdkPackage = readPackage(cdkDir);
  const cdkRequire = createRequire(path.join(cdkDir, "package.json"));
  for (const dependency of ["jsonschema", "semver"]) {
    const actual = readPackage(path.dirname(cdkRequire.resolve(`${dependency}/package.json`)));
    if (!semver.satisfies(actual.version, cdkPackage.dependencies[dependency]))
      throw Error(`Resolved cloud assembly dependency is incompatible: ${dependency}`);
  }
  for (const childName of ["@opentelemetry/resources", "@opentelemetry/sdk-trace-base"]) {
    const childDir = path.dirname(parentRequire.resolve(`${childName}/package.json`));
    if (!childDir.startsWith(`${parentDir}${path.sep}`) ||
        readPackage(childDir).dependencies["@opentelemetry/core"] !== "2.0.0")
      throw Error(`Unexpected Amplify bundled child: ${childName}`);
    const dependency = "@opentelemetry/core";
    const target = path.join(childDir, "node_modules", "@opentelemetry", "core");
    if (!existsSync(target)) {
      const source = path.join(installed, "bello-lock-otel-core");
      const sourcePackage = readPackage(source);
      if (sourcePackage.name !== dependency || sourcePackage.version !== "2.0.0")
        throw Error("Pinned OpenTelemetry repair package mismatch");
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
      repaired++;
    }
    if (readPackage(target).version !== "2.0.0" ||
        createRequire(path.join(childDir, "package.json"))
          .resolve(`${dependency}/package.json`) !== path.join(target, "package.json"))
      throw Error(`Amplify bundled dependency unresolved: ${dependency}`);
  }
}

console.log(`[ensure-amplify-bundled-deps] ${repaired} pinned packages placed`);
