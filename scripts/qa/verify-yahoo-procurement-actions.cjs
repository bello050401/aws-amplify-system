/** Server-action integration tests with isolated data/storage ports; never uses real credentials. */
const { build } = require("esbuild"),
  vm = require("node:vm"),
  assert = require("node:assert/strict");
async function bundle(file, external = false) {
  return (
    await build({
      entryPoints: [file],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
      plugins: external
        ? [
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
          ]
        : [],
    })
  ).outputFiles[0].text;
}
function load(code, mods) {
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: (k) => (Object.hasOwn(mods, k) ? mods[k] : require(k)),
    Buffer,
    URL,
    Date,
    Map,
    Set,
    console,
    setTimeout,
  });
  return module.exports;
}
(async () => {
  const domain = load(await bundle("lib/procurement/yahoo.ts"), {});
  let role = "ADMIN",
    who = "owner",
    records = new Map(),
    inventory = new Map(),
    created = [],
    removed = [],
    uploads = [],
    fail = "",
    existing = [];
  const runId = "11111111-1111-4111-a111-111111111111",
    id = "a1234567890";
  const lot = {
    auctionId: id,
    name: "椅子",
    date: "2026-10-15",
    quantity: 4,
    itemTotal: 35200,
    shipping: 0,
    orderTotal: 35200,
    orderId: "order-1",
    store: true,
    receivedAt: "2026-10-15T01:00:00Z",
    mailId: "abc",
    changed: false,
    warnings: [],
    inventoryId: null,
    possibleDuplicates: [],
  };
  const seller = {
    name: "株式会社見本",
    address: "東京都見本区",
    license: "古物商 許可番号",
    url: "https://auctions.yahoo.co.jp/html/profile/abcdefghijklmn.html?user_type=c",
  };
  const copy = (x) => (x === undefined ? undefined : structuredClone(x)),
    key = (p, s) => p + "|" + s;
  const db = {
    getImportRecord: async (p, s) => copy(records.get(key(p, s))),
    putImportRecord: async (x) => {
      const k = key(x.pk, x.sk);
      if (records.has(k)) throw Error("Conditional");
      records.set(k, copy(x));
    },
    claimImport: async (p, s) => {
      const k = key(p, s),
        old = records.get(k) || {};
      if (old.leaseOwner || old.status === "REGISTERED") return null;
      const owner = "lease";
      records.set(k, { ...old, leaseOwner: owner });
      return owner;
    },
    releaseImport: async (p, s, owner, fields = {}) => {
      const k = key(p, s),
        old = records.get(k);
      assert.equal(old.leaseOwner, owner);
      delete old.leaseOwner;
      Object.assign(old, copy(fields));
    },
  };
  const mods = {
    "node:crypto": require("node:crypto"),
    "next/headers": { cookies: () => {} },
    "aws-amplify/storage/server": {
      uploadData: (context, input) => ({
        result: (async () => {
          if (fail === "upload") throw Error("Network");
          uploads.push(input);
        })(),
      }),
    },
    "@/lib/amplify/serverUtils": {
      runWithAmplifyServerContext: async ({ operation }) => operation({}),
    },
    "@/lib/amplify/requireInventoryUser": {
      canEditInventory: (r) => r === "ADMIN" || r === "EDITOR",
      getInventoryRole: async () => role,
      getCurrentInventoryUserEmail: async () => who,
    },
    "@/lib/saleCandidates/mailReader": {
      purchaseGmailReader: async () => ({
        list: async () => ({ messages: [] }),
        read: async () => {
          throw Error("Unexpected mail access");
        },
      }),
    },
    "@/lib/inventory/queries": {
      listAllInventory: async () => existing,
      listCategories: async () => [],
      listLocations: async () => [],
    },
    "@/lib/inventory/categoryPersistence": {
      getInventoryRaw: async (id) => copy(inventory.get(id)),
    },
    "@/lib/inventory/imageServerOps": {
      removeInventoryImage: async (k) => removed.push(k),
    },
    "./inventory": {
      createInventory: async (input, opts) => {
        if (fail === "before") throw Error("Save failed");
        assert(!inventory.has(opts.id));
        inventory.set(opts.id, copy(input));
        created.push({ input: copy(input), opts });
        if (fail === "after") throw Error("Response lost");
      },
    },
    "@/lib/procurement/store": db,
    "@/lib/procurement/restageLedger": {
      resolveRestageDefaults: () => ({
        categoryId: "repair-master",
        locationId: "office-master",
      }),
    },
    "@/lib/procurement/restage": { classifyItem: () => "椅子" },
    "@/lib/procurement/yahoo": domain,
    "@/lib/procurement/yahooPublic": {
      yahooPublicItem: async () => ({
        name: lot.name,
        date: "2026-10-15",
        imageUrl: "original.jpg",
        storeUrl: seller.url,
      }),
      yahooStore: async () => seller,
      yahooImage: async () => {
        if (fail === "image") throw Error("写真を取得できません。");
        return { bytes: Buffer.from("original bytes"), mime: "image/jpeg" };
      },
    },
  };
  const action = load(
    await bundle("app/actions/yahooProcurement.ts", true),
    mods,
  );
  function reset(store = seller) {
    records = new Map();
    inventory = new Map();
    created = [];
    removed = [];
    uploads = [];
    existing = [];
    fail = "";
    who = "owner";
    role = "ADMIN";
    records.set(key("YAHOO_RUN#" + runId, "STATE"), {
      from: "2026-10-15",
      to: "2026-10-28",
      ids: [],
      index: 0,
      events: [
        {
          kind: "ORDER",
          orderId: lot.orderId,
          auctionIds: [id],
          at: lot.receivedAt,
          lots: [copy(lot)],
        },
      ],
      createdBy: who,
      ttl: Math.floor(Date.now() / 1000) + 3600,
    });
    records.set(key("YAHOO_RUN#" + runId, "LOT#" + id), {
      lot: copy(lot),
      sourceReady: true,
      imageUrl: "original.jpg",
      storeInfo: store,
      defaults: { categoryId: "repair-master", locationId: "office-master" },
    });
  }
  const confirmation = () => [
    {
      auctionId: id,
      quantity: 4,
      itemTotal: 35200,
      shipping: 0,
      amountConfirmed: true,
      distinctConfirmed: false,
    },
  ];
  const register = () =>
    action.registerYahooProcurementAction(runId, id, confirmation());
  reset();
  assert((await register()).ok);
  assert.equal(created.length, 1);
  const p = created[0].input;
  assert.equal(p.purchasePrice, 8800);
  assert.equal(p.quantity, 4);
  assert.equal(p.purchaseQuantity, 4);
  assert.equal(p.dailyPurchaseTotal, 35200);
  assert.equal(p.counterpartyName, seller.name);
  assert.equal(p.counterpartyAddress, seller.address);
  assert.equal(p.identityVerificationMethod, "");
  assert.equal(p.categoryId, "repair-master");
  assert.equal(p.locationId, "office-master");
  assert.equal(
    p.images[0].storageKey,
    "inventory/" + domain.yahooPurchaseId(id) + ".jpg",
  );
  assert.equal(uploads[0].data.toString(), "original bytes");
  assert.equal(p.shippingCost, undefined);
  await register();
  assert.equal(created.length, 1);
  inventory.clear();
  await register();
  assert.equal(created.length, 1); // A deleted imported item is not resurrected.
  reset(null);
  assert((await register()).ok);
  assert.equal(created[0].input.counterpartyName, "");
  assert.equal(created[0].input.counterpartyAddress, "");
  reset();
  const results = await Promise.all([register(), register()]);
  assert.equal(created.length, 1);
  assert(results.some((r) => r.ok));
  reset();
  fail = "after";
  assert((await register()).ok);
  assert.equal(created.length, 1);
  assert.equal(removed.length, 0);
  await register();
  assert.equal(created.length, 1);
  reset();
  fail = "before";
  assert(!(await register()).ok);
  assert.equal(inventory.size, 0);
  assert.equal(removed.length, 1);
  fail = "";
  assert((await register()).ok);
  assert.equal(created.length, 1);
  reset();
  fail = "image";
  assert(!(await register()).ok);
  assert.equal(uploads.length, 0);
  assert.equal(created.length, 0);
  reset();
  role = "VIEWER";
  await assert.rejects(register, /権限/);
  assert.equal(created.length, 0);
  role = "ADMIN";
  who = "another";
  await assert.rejects(register, /有効期限/);
  assert.equal(created.length, 0);
  reset();
  const v = confirmation();
  v[0].shipping = NaN;
  assert(!(await action.registerYahooProcurementAction(runId, id, v)).ok);
  assert.equal(uploads.length, 0);
  reset();
  records.set(key("YAHOO_PURCHASE", id), { status: "EXCLUDED" });
  assert(!(await register()).ok);
  assert.equal(records.get(key("YAHOO_PURCHASE", id)).status, "EXCLUDED");
  assert.equal(
    (await action.previewYahooProcurementAction(runId)).rows.length,
    0,
  );
  reset();
  existing = [
    {
      id: "one",
      name: "other",
      customFields: { __yahooPurchaseImport: { auctionId: id } },
    },
    {
      id: "two",
      name: "different",
      customFields: { __yahooPurchaseImport: { auctionId: id } },
    },
  ];
  assert(!(await action.previewYahooProcurementAction(runId)).ok);
  reset();
  const another = {
    ...lot,
    auctionId: "b1234567890",
    quantity: 2,
    itemTotal: 17600,
  };
  records.get(key("YAHOO_RUN#" + runId, "STATE")).events[0].lots.push(another);
  assert(!(await register()).ok);
  const values = confirmation().concat({
    ...confirmation()[0],
    auctionId: another.auctionId,
    quantity: 2,
    itemTotal: 17600,
  });
  assert((await action.registerYahooProcurementAction(runId, id, values)).ok);
  assert.equal(created[0].input.purchaseQuantity, 6);
  assert.equal(created[0].input.dailyPurchaseTotal, 52800);
  console.log(
    "PASS: 13 server scenarios — store/individual fields; original photo; defaults; repeat/deleted-item dedupe; concurrent registration; uncertain commit; rollback; photo failure; role/owner enforcement; invalid money; exclusions; duplicate source IDs; shared-order ledger.",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
