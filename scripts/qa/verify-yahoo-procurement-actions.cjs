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
  const ledger = load(await bundle("lib/procurement/ledgerDetails.ts"), {});
  const ranges = load(await bundle("lib/procurement/yahooRange.ts"), {});
  const amounts = load(await bundle("lib/procurement/yahooAmounts.ts"), {});
  let role = "ADMIN",
    who = "owner",
    records = new Map(),
    inventory = new Map(),
    created = [],
    removed = [],
    uploads = [],
    fail = "",
    existing = [], queries = [];
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
        list: async (query) => { queries.push(query); return { messages: [] }; },
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
    "@/lib/procurement/yahooRange": ranges,
    "@/lib/procurement/yahooAmounts": amounts,
      "@/lib/procurement/ledgerDetails": ledger,
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
    queries = [];
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
  assert.equal(p.identityVerificationMethod, ledger.PROCUREMENT_IDENTITY_METHOD);
    assert.equal(p.counterpartyOccupation, ledger.PROCUREMENT_OCCUPATION);
    assert.equal(p.customFields.usedGoodsFeature, ledger.procurementFeature(lot.name));
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
  reset();
  const rounded = amounts.initialYahooAmounts({ quantity: 3, itemTotal: 800, shipping: null });
  assert((await action.registerYahooProcurementAction(runId, id, [{
    ...confirmation()[0], quantity: Number(rounded.count), itemTotal: Number(rounded.total), shipping: Number(rounded.postage),
  }])).ok);
  assert.equal(created[0].input.purchasePrice, 267);
  assert.equal(created[0].input.dailyPurchaseTotal, 800);
  reset();
  const edited = amounts.editYahooAmounts(amounts.initialYahooAmounts({ quantity: 4, itemTotal: 35200, shipping: 400 }), "unitPrice", "9000");
  assert((await action.registerYahooProcurementAction(runId, id, [{
    ...confirmation()[0], quantity: Number(edited.count), itemTotal: Number(edited.total), shipping: Number(edited.postage),
  }])).ok);
  assert.equal(created[0].input.purchasePrice, 9000);
  assert.equal(created[0].input.dailyPurchaseTotal, 36000);
  reset();
  inventory.set("manual-existing", { name: "Previously entered stock", quantity: 4 });
  assert((await action.excludeYahooProcurementAction(runId, id, { quantity: 4, itemTotal: 35200, shipping: 0 })).ok);
  assert.equal(records.get(key("YAHOO_PURCHASE", id)).status, "EXCLUDED");
  assert.equal(inventory.size, 1);
  assert.equal(inventory.get("manual-existing").quantity, 4);
  assert.equal(created.length, 0);
  assert.equal(uploads.length, 0);
  assert.equal(removed.length, 0);
  assert((await action.excludeYahooProcurementAction(runId, id, { quantity: 4, itemTotal: 35200, shipping: 0 })).ok);
  assert.equal((await action.previewYahooProcurementAction(runId)).rows.length, 0);
  assert(!(await register()).ok);
  reset();
  assert((await register()).ok);
  assert(!(await action.excludeYahooProcurementAction(runId, id, { quantity: 4, itemTotal: 35200, shipping: 0 })).ok);
  assert.equal(records.get(key("YAHOO_PURCHASE", id)).status, "REGISTERED");
  assert.equal(inventory.size, 1);
  reset();
  records.set(key("YAHOO_PURCHASE", id), { leaseOwner: "other" });
  assert(!(await action.excludeYahooProcurementAction(runId, id, { quantity: 4, itemTotal: 35200, shipping: 0 })).ok);
  reset();
  assert(!(await action.excludeYahooProcurementAction(runId, "b1234567890", { quantity: 4, itemTotal: 35200, shipping: 0 })).ok);
  role = "VIEWER";
  await assert.rejects(() => action.excludeYahooProcurementAction(runId, id, { quantity: 4, itemTotal: 35200, shipping: 0 }), /権限/);
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
  let preview = await action.previewYahooProcurementAction(runId);
  assert(preview.ok);
  assert.equal(preview.rows.length, 0);
  assert.equal(preview.importedCount, 1); // Splits do not block the entire retrieval.
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
  // Default dates need no input; explicit historical retrieval stays available.
  reset();
  let started = await action.startYahooProcurementAction();
  assert(started.ok);
  assert.deepEqual({ from: started.from, to: started.to }, copy(ranges.defaultYahooPurchaseRange()));
  assert.equal(queries[0], domain.yahooPurchaseQuery(started.from, started.to));
  assert.deepEqual(copy(ranges.defaultYahooPurchaseRange(new Date("2026-10-28T12:00:00+09:00"))), {from:"2026-10-15",to:"2026-10-28"});
  assert.deepEqual(copy(ranges.defaultYahooPurchaseRange(new Date("2027-01-01T00:00:00+09:00"))), {from:"2026-12-02",to:"2027-01-01"});
  started = await action.startYahooProcurementAction("2026-10-15", "2026-10-16");
  assert(started.ok);
  assert.equal(started.from, "2026-10-15");
  assert(!(await action.startYahooProcurementAction("2026-10-15")).ok);
  // Merely previewing a purchase does not hide it on another retrieval.
  reset();
  preview = await action.previewYahooProcurementAction(runId);
  assert.equal(preview.rows.length, 1);
  assert.equal((await action.previewYahooProcurementAction(runId)).rows.length, 1);
  records.set(key("YAHOO_PURCHASE", id), {status:"REGISTERED",inventoryId:"deleted-item"});
  preview = await action.previewYahooProcurementAction(runId);
  assert(preview.ok);
  assert.equal(preview.rows.length, 0);
  assert.equal(preview.importedCount, 1); // Deleted imported pages stay excluded too.
  // A duplicate source ID and cancellation must not prevent an unrelated new lot.
  reset();
  existing = ["one", "two"].map(inventoryId => ({id:inventoryId,name:lot.name,adminMemo:`オークションID：${id}`}));
  records.get(key("YAHOO_RUN#" + runId, "STATE")).events[0].lots.push({...another,orderId:"other-order"});
  preview = await action.previewYahooProcurementAction(runId);
  assert(preview.ok);
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.rows[0].auctionId, another.auctionId);
  assert.equal(preview.importedCount, 1);
  // A partly imported combined order uses the imported member's purchase amounts.
  reset();
  records.get(key("YAHOO_RUN#" + runId, "STATE")).events[0].lots.push(another);
  records.set(key("YAHOO_PURCHASE", another.auctionId), {status:"REGISTERED",inventoryId:"sold-already",confirmedPurchase:{quantity:2,itemTotal:17600,shipping:500}});
  preview = await action.previewYahooProcurementAction(runId);
  assert.equal(preview.rows.length, 1);
  assert((await register()).ok);
  assert.equal(created[0].input.purchaseQuantity, 6);
  assert.equal(created[0].input.dailyPurchaseTotal, 53300);
  assert.equal(records.get(key("YAHOO_PURCHASE", id)).confirmedPurchase.itemTotal, 35200);
  // Legacy imports obtain immutable purchase metadata, not the current stock count.
  reset();
  records.get(key("YAHOO_RUN#" + runId, "STATE")).events[0].lots.push(another);
  await action.previewYahooProcurementAction(runId);
  assert((await action.excludeYahooProcurementAction(runId, another.auctionId, {quantity:2,itemTotal:17600,shipping:500})).ok);
  assert((await register()).ok);
  assert.equal(created.length, 1);
  assert.equal(created[0].input.purchaseQuantity, 6);
  assert.equal(created[0].input.dailyPurchaseTotal, 53300);
  assert.equal(records.get(key("YAHOO_PURCHASE", another.auctionId)).status, "EXCLUDED");
  reset();
  records.get(key("YAHOO_RUN#" + runId, "STATE")).events[0].lots.push(another);
  existing = [{id:domain.yahooPurchaseId(another.auctionId),name:another.name,quantity:1,customFields:{__yahooPurchaseImport:{auctionId:another.auctionId,quantity:2,itemTotal:17600,shipping:500}}}];
  await action.previewYahooProcurementAction(runId);
  assert((await register()).ok);
  assert.equal(created[0].input.purchaseQuantity, 6);
  assert.equal(created[0].input.dailyPurchaseTotal, 53300);
  console.log(
    "PASS: Yahoo procurement actions — existing registration safety scenarios plus default/date retrieval, fetched-but-unregistered retry, registered/deleted exclusion, duplicate-source isolation, partial shared orders, immutable legacy purchase amounts.",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
