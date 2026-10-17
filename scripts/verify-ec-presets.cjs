const assert = require("node:assert/strict"),
  esbuild = require("esbuild"),
  vm = require("node:vm"),
  path = require("node:path");
const rows = new Map();
let role = "ADMIN",
  writes = 0;
const gql = async ({ query, variables }) => {
  if (query.includes("query EcPresets"))
    return {
      data: {
        listEcListingPresets: { items: [...rows.values()], nextToken: null },
      },
    };
  const create = query.includes("CreateEcListingPresetInput"),
    input = variables.input,
    old = rows.get(input.id);
  if (create ? !!old : !old || old.revision !== variables.condition.revision.eq)
    return { errors: ["Conflict"] };
  writes++;
  rows.set(input.id, structuredClone(input));
  return {
    data: {
      [create ? "createEcListingPreset" : "updateEcListingPreset"]: {
        id: input.id,
        revision: input.revision,
      },
    },
  };
};
async function load(file) {
  const mocks = {
    "@/lib/amplify/dataClient":
      "export const serverDataClient={graphql:f.gql};",
    "@/lib/amplify/requireInventoryUser":
      "export const getInventoryRole=async()=>f.role();export const canEditInventory=r=>['ADMIN','EDITOR'].includes(r);",
  };
  const result = await esbuild.build({
    entryPoints: [path.resolve(file)],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    plugins: [
      {
        name: "fixtures",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (a) =>
            a.path in mocks ? { path: a.path, namespace: "test" } : null,
          );
          b.onLoad({ filter: /.*/, namespace: "test" }, (a) => ({
            contents: "const f=globalThis.fixture;" + mocks[a.path],
          }));
        },
      },
    ],
  });
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, {
    require,
    module,
    exports: module.exports,
    fixture: { gql, role: () => role },
    console,
  });
  return module.exports;
}
(async () => {
  const pure = await load("lib/listing/ecPresets.ts"),
    actions = await load("app/actions/ecListingPresets.ts");
  const template = structuredClone(pure.DEFAULT_EC_PRESETS[0]);
  assert.equal((await actions.listEcPresetsAction()).length, 5);
  const saved = await actions.saveEcPresetAction(template);
  assert.equal(saved.revision, 1);
  await assert.rejects(() => actions.saveEcPresetAction(template));
  assert.equal(writes, 1, "stale default cannot overwrite");
  const changed = await actions.saveEcPresetAction({
    ...saved,
    name: "大型家具",
    values: { ...saved.values, priceAddition: 5000 },
  });
  assert.equal(changed.revision, 2);
  await assert.rejects(() =>
    actions.saveEcPresetAction({ ...saved, name: "old" }),
  );
  assert.equal(writes, 2);
  await actions.saveEcPresetAction({ ...changed, deleted: true });
  assert.equal(
    (await actions.listEcPresetsAction()).length,
    4,
    "deleted defaults do not reappear",
  );
  role = "EDITOR";
  assert.equal((await actions.listEcPresetsAction()).length, 4);
  await assert.rejects(() =>
    actions.saveEcPresetAction({ ...changed, id: "new" }),
  );
  assert.equal(writes, 3);
  role = "VIEWER";
  await assert.rejects(() => actions.listEcPresetsAction());
  for (const value of [
    null,
    {},
    { ...template, id: undefined },
    { ...template, values: { ...template.values, shopsDelivery: "arbitrary" } },
    { ...template, values: { ...template.values, priceAddition: 0.1 } },
    { ...template, values: { ...template.values, endDays: 8 } },
  ])
    assert.equal(pure.parseEcPreset(value), null);
  assert.equal(pure.presetDescription("説明", "注意事項"), "説明\n\n注意事項");
  assert.equal(
    pure.presetDescription("説明\n\n注意事項", "注意事項"),
    "説明\n\n注意事項",
  );
  assert.equal(
    pure.presetEndAt(
      { ...template.values, endDays: 1, endHour: 22 },
      Date.parse("2026-12-31T14:59:00Z"),
    ),
    "2027-01-01T22:00",
  );
  console.log(
    "EC presets: roles, validation, stale-save protection and defaults passed. No live writes.",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
