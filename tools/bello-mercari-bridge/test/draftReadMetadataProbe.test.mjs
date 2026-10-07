import test from "node:test";
import assert from "node:assert/strict";
import { probeDraftReadMetadataOnce } from "../src/draftReadMetadataProbe.mjs";

const shopId = "evkhihBFFNn5hukMS9s36H";
const listUrl = `https://mercari-shops.com/seller/shops/${shopId}/products?tab=draft`;
const detailUrl = `https://mercari-shops.com/seller/shops/${shopId}/products/create?productDraftId=hiddenDraft123`;
const options = { root: "C:\\Queue", profileDir: "C:\\ShopsChrome",
  playwrightModulePath: "C:\\App\\node_modules\\playwright\\package.json",
  shopId, confirmReadOnly: true, expectedRowCount: 12, rowIndex: 0 };

function fakeSession({ count = 12, auth = false } = {}) {
  let url = "about:blank";
  let routeHandler;
  let websocketHandler;
  let rowClicks = 0;
  let reads = 0;
  let closed = false;
  const page = {
    route: async (_pattern, handler) => { routeHandler = handler; },
    routeWebSocket: async (_pattern, handler) => { websocketHandler = handler; },
    unroute: async () => {},
    goto: async () => { url = auth ? "https://mercari-shops.com/signin/seller" : listUrl; },
    url: () => url, waitForTimeout: async () => {},
    locator: selector => selector === "body" ? { evaluate: async () => ({
      documentUrl: url, tableMatches: 1, tableIndex: 0,
      loading: false, paginationControls: 0,
      rows: Array.from({ length: typeof count === "function" ? count(++reads) : count }, () => ({ cellCount: 8,
        signature: '["","","¥0","0","","","",""]', interactiveCount: 0 })),
    }) } : selector === "table" ? { nth: () => ({ locator: () => ({
      nth: () => ({ click: async () => { rowClicks++; url = detailUrl; } }),
    }) }) } : { waitFor: async () => {}, count: async () => 1 },
  };
  const context = { close: async () => { closed = true; } };
  return { page, context, routeHandler: () => routeHandler,
    websocketHandler: () => websocketHandler,
    rowClicks: () => rowClicks, closed: () => closed };
}

test("one opt-in probe observes only metadata and always closes", async () => {
  const session = fakeSession();
  let stopped = false;
  const result = await probeDraftReadMetadataOnce({ ...options,
    openSession: async () => session,
    observe: () => ({ stop: async () => { stopped = true; return {
      status: "METADATA_ONLY", observations: [{
        pageKind: "DRAFT_DETAIL", operationClass: "NAMED_QUERY",
        httpStatus: 200, hasErrors: false, leakedId: "hiddenDraft123",
        responseShape: { type: "object", fieldCount: 1, overLimit: false,
          typeCounts: { null: 0, array: 0, object: 1, string: 0,
            number: 0, boolean: 0 } },
      }] }; } }),
  });
  assert.equal(result.status, "DRAFT_UI_READ_OBSERVED");
  assert.equal(result.closeStatus, "CLOSED");
  assert.equal(result.allowFinalCreate, false);
  assert.equal(session.rowClicks(), 1);
  assert.equal(stopped, true);
  assert.equal(session.closed(), true);
  assert.equal(JSON.stringify(result).includes("hiddenDraft123"), false);
  assert.deepEqual(result.observations[0].typeCounts,
    { null: 0, array: 0, object: 1, string: 0, number: 0, boolean: 0 });
  const calls = [];
  const route = (method, url, query = "") => ({
    request: () => ({ method: () => method, url: () => url,
      resourceType: () => "fetch", postDataBuffer: () => Buffer.from(query) }),
    continue: async () => calls.push("continue"),
    abort: async () => calls.push("abort"),
  });
  await session.routeHandler()(route("GET", listUrl));
  await session.routeHandler()(route("POST", "https://mercari-shops.com/graphql",
    JSON.stringify({ operationName: "SaveDraft",
      query: "mutation SaveDraft { saveDraft { id } }" })));
  await session.routeHandler()(route("POST", "https://mercari-shops.com/graphql",
    JSON.stringify({ operationName: "EditProductPage",
      query: "query EditProductPage { product { id } }" })));
  assert.deepEqual(calls, ["continue", "abort", "continue"]);
  let websocketClosed = false;
  await session.websocketHandler()({ close: async () => { websocketClosed = true; } });
  assert.equal(websocketClosed, true);
});

test("opt-in, transient row count, and auth uncertainty fail closed", async () => {
  let opened = false;
  const noOptIn = await probeDraftReadMetadataOnce({ ...options,
    confirmReadOnly: false, openSession: async () => { opened = true; } });
  assert.equal(noOptIn.status, "INPUT_UNVERIFIED");
  assert.equal(opened, false);
  const transient = fakeSession({ count: 13 });
  const result = await probeDraftReadMetadataOnce({ ...options,
    openSession: async () => transient,
    observe: () => ({ stop: async () => ({ observations: [] }) }) });
  assert.equal(result.status, "DRAFT_LIST_UNVERIFIED");
  assert.equal(transient.rowClicks(), 0);
  assert.equal(transient.closed(), true);
  const changing = fakeSession({ count: read => read === 2 ? 13 : 12 });
  const changed = await probeDraftReadMetadataOnce({ ...options,
    openSession: async () => changing,
    observe: () => ({ stop: async () => ({ observations: [] }) }) });
  assert.equal(changed.status, "DRAFT_LIST_UNVERIFIED");
  assert.equal(changing.rowClicks(), 0);
  const auth = fakeSession({ auth: true });
  const redirected = await probeDraftReadMetadataOnce({ ...options,
    openSession: async () => auth,
    observe: () => ({ stop: async () => ({ observations: [] }) }) });
  assert.equal(redirected.status, "AUTH_REQUIRED");
  assert.equal(auth.closed(), true);
  const unguarded = fakeSession();
  unguarded.page.routeWebSocket = undefined;
  const blocked = await probeDraftReadMetadataOnce({ ...options,
    openSession: async () => unguarded,
    observe: () => { throw Error("Observer must not attach"); } });
  assert.equal(blocked.status, "READ_UNAVAILABLE");
  assert.equal(unguarded.rowClicks(), 0);
  assert.equal(unguarded.closed(), true);
});
