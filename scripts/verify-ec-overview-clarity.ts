import assert from "node:assert/strict";
import { buildPackageQuote, type PackageRate } from "../lib/shipping/packages";
import { JAPAN_PREFECTURES } from "../lib/shipping/prefectures";
import {
  KAZAI_PROVIDER_NAME,
  KAZAI_SERVICE_NAME,
} from "../lib/shipping/serviceName";
import {
  observedChannel,
  overlayManualStatuses,
  type ExternalProduct,
  type ManualLink,
} from "../lib/listing/econveni/manualSyncModel";
import {
  overviewItems,
  overviewChannel,
  isProtectedSale,
  matchesListingState,
  categoryMatches,
} from "../lib/listing/overviewCatalogModel";
import type { EcCatalog } from "../lib/listing/ecManagement";
import type { ListingOverviewRow } from "../lib/listing/service";
let count = 0;
const test = (label: string, fn: () => void) => {
  fn();
  console.log("PASS " + label);
  count++;
};
const rates: PackageRate[] = JAPAN_PREFECTURES.flatMap((p, i) =>
  (p === "北海道" ? ["道南", "道央", "道北", "道東"] : [null]).map((area) => ({
    provider: KAZAI_PROVIDER_NAME,
    service: KAZAI_SERVICE_NAME,
    originPrefecture: "埼玉県",
    destinationPrefecture: p,
    destinationArea: area,
    rank: "A" as const,
    price: 1000 + i,
    taxIncluded: true,
    currency: "JPY" as const,
    surcharge: null,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    verifiedAt: "2026-01-01",
    status: "VERIFIED" as const,
    version: 1,
  })),
);
const quote = (rs: PackageRate[], destinationKey?: string) =>
  buildPackageQuote({
    rates: rs,
    packages: [{ id: "main", name: "", rank: "A" }],
    estimatedRank: "A",
    plannedPrice: 10000,
    asOfDate: "2026-11-01",
    destinationKey,
    requireAllPrefectures: true,
  });
test("地域は取得順にかかわらず北海道から沖縄、北海道の区分は連続", () => {
  const a = quote(rates).regions,
    b = quote([...rates].reverse()).regions;
  assert.deepEqual(a, b);
  assert.deepEqual(
    a.slice(0, 4).map((r) => r.label),
    ["北海道 道北", "北海道 道東", "北海道 道央", "北海道 道南"],
  );
  assert.equal(a[4].label, "青森県");
  assert.equal(a.at(-1)?.label, "沖縄県");
  assert.equal(a.length, 50);
});
test("並べ替えても選択値・地域別料金・全国中央値が変わらない", () => {
  for (const r of quote(rates).regions)
    assert.deepEqual(quote(rates, r.key), quote([...rates].reverse(), r.key));
  assert.equal(
    quote(rates).shippingTotal,
    quote([...rates].reverse()).shippingTotal,
  );
});
const product: ExternalProduct = {
  productId: "1",
  title: "椅子",
  imageUrl: null,
  quantity: 5,
  price: 10000,
  inventoryMarker: null,
  channels: {
    BASE: { state: "INACTIVE", listingId: null, listingUrl: null },
    YAHOO: { state: "ACTIVE", listingId: "yahoo-old", listingUrl: null },
    MERCARI_SHOPS: { state: "INACTIVE", listingId: null, listingUrl: null },
  },
};
const link: ManualLink = {
  productId: "1",
  inventoryId: "stock",
  inventoryName: "椅子",
  remoteTitle: "椅子",
  linkedAt: "2026-01-01",
  actor: "test",
  revision: 1,
  baseline: {
    ...product.channels,
    BASE: { state: "ACTIVE", listingId: "base-old", listingUrl: null },
  },
};
test("番号が消えた「未」は出品なし。停止成功やエラーを捏造しない", () => {
  const s = observedChannel(product, "BASE", link, "2026-11-01");
  assert.equal(s.state, "UNLISTED");
  assert.equal(s.note, undefined);
  assert.equal(s.externalId, "base-old");
});
test("商品自体が取得できないケースは確認が必要", () =>
  assert.equal(
    observedChannel(null, "BASE", link, "2026-11-01").state,
    "ERROR",
  ));
test("未確認の送信は未表示で上書きしない", () => {
  const c: EcCatalog = {
    channels: {
      BASE: {
        stock: {
          state: "PENDING",
          externalId: "base-old",
          url: null,
          checkedAt: "2026-01-01",
        },
      },
    },
    archivedIds: [],
    errors: [],
  };
  overlayManualStatuses(c, {
    links: [link],
    snapshot: { version: "v", checkedAt: "2026-11-01", products: [product] },
  });
  assert.equal(c.channels.BASE?.stock.state, "PENDING");
});
const row: ListingOverviewRow = {
  inventoryId: "stock",
  displayId: "B1",
  name: "【社内メモ】椅子",
  quantity: 0,
  price: 10000,
  thumbnailKey: null,
  inventoryUpdatedAt: "2026-11-01",
  hasDraft: true,
  channelListing: null,
  categories: ["売り切れ"],
  soldChannel: "YAHOO",
};
const catalog: EcCatalog = {
  channels: {},
  errors: [],
  archivedIds: [],
  econveni: {
    checkedAt: "2026-11-01",
    products: [
      { product, inventoryId: "stock", inventory: row },
      {
        product: { ...product, productId: "2" },
        inventoryId: null,
        inventory: null,
      },
    ],
  },
  soldListings: { stock: { YAHOO: ["yahoo-old"] } },
};
overlayManualStatuses(catalog, {
  links: [link],
  snapshot: { version: "v", checkedAt: "2026-11-01", products: [product] },
});
const items = overviewItems([row], catalog, "ECONVENI");
test("eコンビニ全件を同順で表示し未連携も欠落しない", () => {
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((i) => i.remote?.productId),
    ["1", "2"],
  );
  assert.equal(items[1].row, null);
});
test("BELLO一覧は重複在庫を含めて独立して維持", () =>
  assert.equal(
    overviewItems([row, { ...row, inventoryId: "split" }], catalog, "BELLO")
      .length,
    2,
  ));
test("読み込んだ在庫数量を古い下書き数量で上書きしない", () => {
  const list = overviewItems([{ ...row, quantity: 99 }], catalog, "ECONVENI");
  assert.equal(list[0].row?.quantity, 0);
  assert.equal(list[0].row?.hasDraft, true);
});
test("売却した販売先は保持、他の未は正常表示", () => {
  assert.equal(isProtectedSale(items[0], catalog, "YAHOO"), true);
  assert.equal(isProtectedSale(items[0], catalog, "BASE"), false);
  assert.equal(overviewChannel(items[0], catalog, "BASE").state, "UNLISTED");
  assert.equal(
    matchesListingState(items[0], catalog, "ALL", "ATTENTION"),
    false,
  );
});
test("全販売先で出品なしに、他で出品中のものを混ぜない", () => {
  assert.equal(
    matchesListingState(items[1], catalog, "ALL", "INACTIVE"),
    false,
  );
  assert.equal(matchesListingState(items[1], catalog, "ALL", "ACTIVE"), true);
  assert.equal(
    matchesListingState(items[1], catalog, "BASE", "INACTIVE"),
    true,
  );
});
test("売却済みの保持ページは販売中フィルタに入れない", () => {
  assert.equal(matchesListingState(items[0], catalog, "ALL", "ACTIVE"), false);
  assert.equal(matchesListingState(items[0], catalog, "ALL", "INACTIVE"), true);
});
test("在庫カテゴリとEC状態は別条件", () => {
  assert.equal(categoryMatches(row, "売り切れ"), true);
  assert.equal(categoryMatches(row, "販売中"), false);
  assert.equal(categoryMatches(null, "UNLINKED"), true);
  assert.equal(
    categoryMatches({ ...row, categories: ["出品中"] }, "販売中"),
    true,
  );
});
test("部分売却後の販売先は同じ出品IDだけ保持、再出品IDは対象外", () => {
  const item = {
    ...items[0],
    row: { ...row, quantity: 3, categories: ["販売中"], soldChannel: null },
  };
  assert.equal(isProtectedSale(item, catalog, "YAHOO"), true);
  const renewed = structuredClone(catalog);
  renewed.channels.YAHOO!.stock.externalId = "yahoo-new";
  assert.equal(isProtectedSale(item, renewed, "YAHOO"), false);
});
console.log(`${count} overview and shipping checks passed`);
