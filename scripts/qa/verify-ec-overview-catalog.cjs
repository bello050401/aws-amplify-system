const { build } = require("esbuild"),
  vm = require("vm"),
  assert = require("assert/strict");
(async () => {
  const code = (
    await build({
      entryPoints: ["lib/listing/econveni/overviewCatalog.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
      plugins: [
        {
          name: "isolate",
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
  let calls = [],
    retry = false,
    forever = false,
    queryPage = 0;
  class BatchGetCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class QueryCommand {
    constructor(input) {
      this.input = input;
    }
  }
  const db = {
    send: async (c) => {
      calls.push(c.input);
      if (c instanceof QueryCommand) {
        queryPage++;
        return {
          Items:
            queryPage === 1
              ? [
                  {
                    channel: "YAHOO",
                    orderId: "auction1",
                    identifierType: "AUCTION",
                    result: { sourceId: "i0" },
                  },
                ]
              : [
                  {
                    channel: "BASE",
                    externalListingId: "base1",
                    result: { sourceId: "i0" },
                  },
                ],
          LastEvaluatedKey: queryPage === 1 ? { id: "next" } : undefined,
        };
      }
      const keys = c.input.RequestItems.stock.Keys;
      if (forever || retry) {
        retry = false;
        return {
          Responses: { stock: [] },
          UnprocessedKeys: { stock: { Keys: keys } },
        };
      }
      return {
        Responses: {
          stock: keys.map((k) => ({
            id: k.id,
            name: "商品" + k.id,
            quantity: 3,
            categoryIds: ["c"],
            market: "ヤフオク",
            updatedAt: "2026-11-01",
            ...(k.id === "i2" ? { deletedAt: "date" } : {}),
          })),
        },
      };
    },
  };
  const mods = {
    "server-only": {},
    "@aws-sdk/lib-dynamodb": { BatchGetCommand, QueryCommand },
    "@/lib/inventory/categoryPersistence": {
      inventoryDdb: db,
      inventoryTable: () => "stock",
    },
    "@/lib/inventory/masters": {
      listAllMasterEntries: async () => [{ id: "c", name: "販売中" }],
    },
    "@/lib/saleCandidates/store": {
      candidateConfig: () => ({ tableName: "sales" }),
    },
  };
  const m = { exports: {} };
  vm.runInNewContext(code, {
    module: m,
    exports: m.exports,
    require: (k) => {
      if (!mods[k]) throw Error("Unexpected " + k);
      return mods[k];
    },
    Map,
    Set,
    Array,
    Object,
    Number,
    String,
    Error,
  });
  const { remoteOverview, soldListingReferences } = m.exports;
  const products = Array.from({ length: 105 }, (_, i) => ({
      productId: String(i),
      title: "商品",
      quantity: 1,
      price: 100,
      channels: {},
    })),
    links = products
      .slice(0, 104)
      .map((p, i) => ({ productId: p.productId, inventoryId: "i" + i }));
  retry = true;
  const result = await remoteOverview(
    { snapshot: { checkedAt: "date", products }, links },
    [],
  );
  assert.equal(result.products.length, 105);
  assert.equal(result.products[104].inventory, null);
  assert.equal(result.products[2].inventory, null);
  assert.equal(result.products[0].inventory.quantity, 3);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.products[0].inventory.categories)),
    ["販売中"],
  );
  assert(
    calls.every(
      (c) => !c.RequestItems || c.RequestItems.stock.Keys.length <= 100,
    ),
  );
  assert(
    calls.every(
      (c) =>
        !c.RequestItems ||
        !c.RequestItems.stock.ProjectionExpression.includes("customFields"),
    ),
  );
  console.log(
    "PASS batched linked-only reads, retry, all products/order retained, deleted stock not actionable, no private fields",
  );
  const ambiguous = await remoteOverview(
    {
      snapshot: { checkedAt: "date", products: products.slice(0, 1) },
      links: [links[0], { ...links[0], inventoryId: "other" }],
    },
    [],
  );
  assert.equal(ambiguous.products[0].inventory, null);
  assert.equal(ambiguous.products[0].ambiguous, true);
  console.log("PASS ambiguous links cannot create operational rows");
  forever = true;
  await assert.rejects(
    () =>
      remoteOverview(
        {
          snapshot: { checkedAt: "date", products: products.slice(0, 1) },
          links: links.slice(0, 1),
        },
        [],
      ),
    /INCOMPLETE/,
  );
  forever = false;
  console.log(
    "PASS incomplete database reads never silently become zero-stock rows",
  );
  const refs = await soldListingReferences();
  assert.deepEqual(JSON.parse(JSON.stringify(refs)), {
    i0: { YAHOO: ["auction1"], BASE: ["base1"] },
  });
  assert.equal(queryPage, 2);
  console.log(
    "PASS sale ID references across pages without buyer or financial data",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
