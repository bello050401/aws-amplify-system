// Called by the authenticated desktop GPT worker after actual browser observation.
// Does not generate QA findings; input must contain the observed evidence.
import fs from "node:fs";
import path from "node:path";
const root = (process.env.BELLO_ECO_LIVE_ROOT || "C:/Users/win/Documents/Codex/bello-eco-live-20260916").replaceAll('\\', '/');
if (!/^C:\/Users\/win\/Documents\/Codex\/bello-eco-live-20260916(?:-[a-z0-9-]+)?$/.test(root)) throw Error('Dedicated smoke directory required');
const phase = process.argv[2],
  input = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const requests = fs
  .readdirSync(root + "/qa-requests")
  .filter((name) => name.endsWith(".request.json"))
  .map((name) =>
    JSON.parse(fs.readFileSync(root + "/qa-requests/" + name, "utf8")),
  );
const request = requests.find(
  (r) =>
    r.phase === phase &&
    !fs.existsSync(root + "/qa-requests/" + r.operationKey + ".response.json"),
);
if (!request || request.expiresAt < Date.now())
  throw Error("No active scoped desktop request");
const proof = phase + "-desktop-observation.json";
const evidenceDirectory = root + "/evidence/" + request.runId;
fs.writeFileSync(
  path.join(evidenceDirectory, proof),
  JSON.stringify(
    {
      observedAt: new Date().toISOString(),
      observer: "GPT desktop session",
      ...input.evidence,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
const body = { ...input.body };
if (phase !== "specification") {
  Object.assign(body, {
    specId: request.specId || "initial-discovery",
    url: request.url,
    revision: request.headSHA || body.revision,
    deploymentId: request.deployment?.deploymentId || body.deploymentId,
  });
  body.acceptanceCriteria = body.acceptanceCriteria.map((ac) => ({
    ...ac,
    evidenceRefs: [proof],
  }));
}
const artifact = {
  schemaVersion: 1,
  runId: request.runId,
  revision: request.revision,
  producer: "gpt-desktop-session",
  kind: phase === "specification" ? "spec" : "qa",
  parentArtifactIds: request.specId
    ? [request.specId]
    : request.initialQaId
      ? [request.initialQaId]
      : [],
  evidenceRefs: [proof],
  body,
};
const response = {
  operationKey: request.operationKey,
  token: request.token,
  artifact,
};
const file = root + "/qa-requests/" + request.operationKey + ".response.json";
fs.writeFileSync(file + ".tmp", JSON.stringify(response), { flag: "wx" });
fs.renameSync(file + ".tmp", file);
console.log("Desktop artifact submitted for " + phase);
