const { build } = require("esbuild"),
  vm = require("vm"),
  assert = require("assert/strict");
(async () => {
  const code = (
    await build({
      entryPoints: ["lib/listing/econveni/manualStop.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
      plugins: [
        {
          name: "ports",
          setup(b) {
            b.onResolve({ filter: /.*/ }, (a) =>
              a.kind === "entry-point"
                ? undefined
                : { path: a.path, external: true },
            );
          },
        },
      ],
    })
  ).outputFiles[0].text;
  let receipt;
  class ScanCommand {
    constructor(input) {
      this.input = input;
    }
  }
  const m = { exports: {} };
  vm.runInNewContext(code, {
    module: m,
    exports: m.exports,
    require: (k) =>
      k === "@aws-sdk/lib-dynamodb"
        ? { ScanCommand }
        : k === "./runtimeStore"
          ? {
              econveniDatabase: { send: async () => ({ Items: [receipt] }) },
              ECONVENI_WORKFLOW_TABLE: "table",
            }
          : {},
  });
  const manual = { links: [{ inventoryId: "i", productId: "p", revision: 1 }] };
  const run = async (state, time, command = "DONE", id = "id") => {
    const catalog = {
      channels: {
        BASE: {
          i: { state, checkedAt: time, source: "ECONVENI", externalId: id },
        },
      },
    };
    receipt = {
      inventoryId: "i",
      productId: "p",
      linkRevision: 1,
      channel: "BASE",
      listingId: "id",
      state: command,
      updatedAt: "2026-11-01T00:00:00Z",
    };
    await m.exports.overlayManualStops(catalog, manual);
    return catalog.channels.BASE.i;
  };
  assert.equal((await run("ACTIVE", "2026-11-02T00:00:00Z")).state, "ACTIVE");
  assert.equal(
    (await run("UNLISTED", "2026-11-02T00:00:00Z")).state,
    "STOPPED",
  );
  assert.equal(
    (await run("UNLISTED", "2026-11-02T00:00:00Z", "PENDING")).state,
    "ERROR",
  );
  assert.equal((await run("ACTIVE", "2026-10-31T00:00:00Z")).state, "STOPPED");
  assert.equal(
    (await run("ACTIVE", "2026-11-02T00:00:00Z", "DONE", "replacement")).state,
    "ACTIVE",
  );
  console.log(
    "PASS 5 stop overlays: newer active, confirmed inactive, pending remains warning, older snapshot, replacement listing",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
