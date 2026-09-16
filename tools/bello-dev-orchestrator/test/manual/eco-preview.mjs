// Synthetic local UI only. No worker loop, AWS, agents, or operational DB.
import { buildHarness } from "../helpers.mjs";
import { Dashboard } from "../../src/dashboard/server.mjs";
import { installEcoSchema } from "../../src/eco/store.mjs";
const h = await buildHarness({
  dashboard: { host: "127.0.0.1", port: 4327, lanAccess: false },
});
h.repo.setPaused(true);
installEcoSchema(h.store);
process.env.BELLO_ECO_OPERATOR_TOKEN = "synthetic-preview-only";
const dashboard = new Dashboard({
  ...h,
  diagnostics: { report: async () => ({ synthetic: true }) },
});
await dashboard.start();
console.log(
  JSON.stringify({
    url: "http://127.0.0.1:4327",
    db: h.paths.dbFile,
    synthetic: true,
  }),
);
process.on("SIGINT", async () => {
  await dashboard.stop();
  h.cleanup();
  process.exit(0);
});
