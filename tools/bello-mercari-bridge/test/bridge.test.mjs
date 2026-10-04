import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { bindAccount, enqueueExistingRead, listReadResults, saveReadResult, withReadLock } from "../src/queue.mjs";
import { runExistingRead } from "../src/readWorker.mjs";
import { openDedicatedLogin, openExistingProductReadSession } from "../src/session.mjs";
import { createExistingProductReader } from "../src/existingProductReader.mjs";

const account = "synthetic-shop";
const observed = value => ({ kind: "OBSERVED", value });
const unobserved = { kind: "UNOBSERVED" };
const execFileAsync = promisify(execFile);

async function withRoot(run) {
  const prefix = join(tmpdir(), "bello-mercari-bridge-test-");
  const root = await mkdtemp(prefix);
  try { await run(root); }
  finally {
    if (!resolve(root).startsWith(resolve(prefix))) throw Error("Test cleanup escaped its own root");
    await rm(root, { recursive: true, force: true });
  }
}

async function job(root) {
  return enqueueExistingRead(root, {
    accountReference: account, inventoryCode: "SKU-1", remoteId: "existing-product",
    expectedFields: { title: "QA title", description: "QA description", priceYen: 90000,
      quantity: 0, primaryImageIdentity: "known-image" },
  });
}

function exactObservation(overrides = {}) {
  return { exactProductReadBack: true, accountReference: observed(account),
    remoteId: observed("existing-product"), visibility: observed("PRIVATE"),
    fields: { inventoryCode: observed("SKU-1"), title: observed("QA title"),
      description: observed("QA description"), priceYen: observed(90000),
      quantity: observed(0), primaryImageIdentity: observed("known-image") }, ...overrides };
}

test("queue is bound to one account and stores a read-only exact-ID request", async () => withRoot(async root => {
  const queued = await job(root);
  assert.equal(queued.operation, "READ_EXISTING");
  assert.equal(queued.remoteId, "existing-product");
  await assert.rejects(bindAccount(root, "another-shop"));
  await assert.rejects(enqueueExistingRead(root, { accountReference: account, inventoryCode: "SKU-1",
    remoteId: "existing-product", expectedFields: { cookie: "secret" } }));
  const [file] = await readdir(join(root, "jobs"));
  const serialized = await readFile(join(root, "jobs", file), "utf8");
  assert.ok(!/cookie|token|password|authorization/i.test(serialized));
}));

test("without a reviewed reader the worker stores connector-not-configured, never success", async () => withRoot(async root => {
  const queued = await job(root);
  const result = await runExistingRead(root, account, queued.jobId);
  assert.equal(result.status, "CONNECTOR_NOT_CONFIGURED");
  assert.equal(result.remoteId, queued.remoteId);
  assert.equal((await listReadResults(root, queued.jobId)).length, 1);
}));

test("auth required and unknown keep the same ID; a later explicit read can compare", async () => withRoot(async root => {
  const queued = await job(root);
  const calls = [];
  const auth = await runExistingRead(root, account, queued.jobId, { readExactProduct(input) {
    calls.push(input); return { kind: "AUTH_REQUIRED" };
  } });
  assert.equal(auth.status, "AUTH_REQUIRED");
  const unknown = await runExistingRead(root, account, queued.jobId, { readExactProduct() { throw Error("raw secret must not persist"); } });
  assert.equal(unknown.status, "UNKNOWN");
  const incomplete = await runExistingRead(root, account, queued.jobId, { readExactProduct() {
    return { kind: "OBSERVED", observation: exactObservation({ visibility: unobserved,
      fields: { ...exactObservation().fields, primaryImageIdentity: unobserved } }) };
  } });
  assert.equal(incomplete.status, "INCOMPLETE");
  assert.equal(incomplete.comparison.visibility, "UNOBSERVED");
  assert.equal(incomplete.comparison.fields.primaryImageIdentity, "UNOBSERVED");
  const matched = await runExistingRead(root, account, queued.jobId, { readExactProduct() {
    return { kind: "OBSERVED", observation: exactObservation() };
  } });
  assert.equal(matched.status, "CORE_FIELDS_MATCH");
  assert.deepEqual(calls, [{ accountReference: account, remoteId: "existing-product" }]);
  const history = await listReadResults(root, queued.jobId);
  assert.equal(history.length, 4);
  assert.ok(history.every(item => item.remoteId === queued.remoteId));
  assert.ok(!JSON.stringify(history).includes("raw secret"));
}));

test("another account or ID cannot promote privacy or the target fields", async () => withRoot(async root => {
  const queued = await job(root);
  for (const observation of [
    exactObservation({ accountReference: observed("other-shop") }),
    exactObservation({ remoteId: observed("other-product") }),
  ]) {
    const result = await runExistingRead(root, account, queued.jobId, { readExactProduct() {
      return { kind: "OBSERVED", observation };
    } });
    assert.equal(result.status, "IDENTITY_MISMATCH");
    assert.equal(result.comparison.visibility, "UNOBSERVED");
    assert.equal(result.comparison.fields.inventoryCode, "UNOBSERVED");
  }
}));

test("malformed observation discriminants never become matched fields or private state", async () => withRoot(async root => {
  const queued = await job(root);
  for (const observation of [
    exactObservation({ exactProductReadBack: "false" }),
    exactObservation({ visibility: { kind: "UNVERIFIED", value: "PRIVATE" } }),
    exactObservation({ fields: { ...exactObservation().fields,
      inventoryCode: { kind: "UNVERIFIED", value: "SKU-1" } } }),
  ]) {
    const result = await runExistingRead(root, account, queued.jobId, { readExactProduct() {
      return { kind: "OBSERVED", observation };
    } });
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.comparison, null);
  }
}));

test("result store strips extra data and rejects another account or remote ID", async () => withRoot(async root => {
  const queued = await job(root);
  const standard = await runExistingRead(root, account, queued.jobId, { readExactProduct() {
    return { kind: "OBSERVED", observation: exactObservation() };
  } });
  await saveReadResult(root, queued.jobId, { accountReference: account, remoteId: queued.remoteId,
    status: "CORE_FIELDS_MATCH", comparison: { ...standard.comparison,
      cookie: "synthetic-credential", rawPage: "synthetic-page-dump" },
    rawResponse: "synthetic-secret" });
  const records = await listReadResults(root, queued.jobId);
  const serialized = JSON.stringify(records);
  assert.ok(!serialized.includes("synthetic-credential"));
  assert.ok(!serialized.includes("synthetic-page-dump"));
  assert.ok(!serialized.includes("synthetic-secret"));
  await assert.rejects(saveReadResult(root, queued.jobId, {
    accountReference: "other-shop", remoteId: queued.remoteId, status: "UNKNOWN",
  }));
  await assert.rejects(saveReadResult(root, queued.jobId, {
    accountReference: account, remoteId: "other-product", status: "UNKNOWN",
  }));
  await assert.rejects(saveReadResult(root, queued.jobId, {
    accountReference: account, remoteId: queued.remoteId, status: "UNKNOWN", reasonCode: "synthetic-secret",
  }));
  assert.equal((await listReadResults(root, queued.jobId)).length, 2);
}));

test("one explicit read lock rejects a concurrent run", async () => withRoot(async root => {
  const queued = await job(root);
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const first = withReadLock(root, queued.jobId, async () => { entered(); await hold; });
  await started;
  await assert.rejects(withReadLock(root, queued.jobId, async () => {}));
  release();
  await first;
}));

test("dedicated login launcher requests a visible new profile and official sign-in only", async () => withRoot(async root => {
  const visits = [];
  const context = { pages: () => [], newPage: async () => ({ goto: async url => { visits.push(url); } }), close: async () => {} };
  const launched = await openDedicatedLogin({ profileDir: join(root, "new-profile"),
    launchPersistentContext: async (profile, options) => {
      assert.equal(profile, join(root, "new-profile"));
      assert.deepEqual(options, { channel: "chrome", headless: false });
      return context;
    } });
  assert.equal(launched, context);
  assert.deepEqual(visits, ["https://mercari-shops.com/signin/seller"]);
  const occupied = join(root, "existing-browser-profile");
  await mkdir(occupied);
  await writeFile(join(occupied, "Cookies"), "synthetic-existing-profile");
  await assert.rejects(openDedicatedLogin({ profileDir: occupied,
    launchPersistentContext: async () => { throw Error("must not launch"); } }));
}));

test("existing product navigation reuses the separate profile but never claims read-back", async () => withRoot(async root => {
  let currentUrl = "";
  const page = { goto: async url => { currentUrl = url; }, url: () => currentUrl };
  const context = { pages: () => [page], close: async () => {} };
  const input = { root, profileDir: join(root, "profile"), shopId: "shop-one", remoteId: "product-one",
    launchPersistentContext: async () => context };
  const result = await openExistingProductReadSession(input);
  assert.equal(result.state, "NAVIGATED_UNVERIFIED");
  assert.equal(currentUrl, "https://mercari-shops.com/seller/shops/shop-one/products/product-one/edit");
  const redirected = await openExistingProductReadSession({ ...input,
    launchPersistentContext: async () => ({ pages: () => [{
      goto: async () => { currentUrl = "https://mercari-shops.com/signin/seller"; }, url: () => currentUrl,
    }], close: async () => {} }) });
  assert.equal(redirected.state, "AUTH_REQUIRED");
  await assert.rejects(openExistingProductReadSession({ ...input, remoteId: "../other" }));
  await assert.rejects(openExistingProductReadSession({ ...input, shopId: "other-shop" }));
}));

test("traffic observer attaches before normal exact-product navigation and keeps no raw URL", async () => withRoot(async root => {
  const context = new EventEmitter();
  let currentUrl = "";
  const page = { goto: async url => {
    currentUrl = url;
    context.emit("response", { url: () => "https://api.mercari-shops.com/api/v1/products/privateId?token=secret",
      status: () => 200, request: () => ({ method: () => "GET", resourceType: () => "fetch" }) });
  }, url: () => currentUrl };
  context.pages = () => [page];
  context.close = async () => {};
  const session = await openExistingProductReadSession({ root, profileDir: join(root, "traffic-profile"),
    shopId: account, remoteId: "existing-product", observeTraffic: true,
    launchPersistentContext: async () => context });
  assert.equal(session.state, "NAVIGATED_UNVERIFIED");
  assert.deepEqual(session.traffic.snapshot(), [{ host: "*.mercari-shops.com", method: "GET",
    type: "fetch", path: "/api/v1/products/:value", status: 200, count: 1 }]);
  assert.equal(JSON.stringify(session.traffic.snapshot()).includes("secret"), false);
  session.traffic.stop();
  await session.context.close();
}));

test("CLI can enqueue an existing-ID read and records a blocked result without a connector", async () => withRoot(async root => {
  const expectedFile = join(root, "expected.json");
  await writeFile(expectedFile, JSON.stringify({ title: "QA title", priceYen: 90000, quantity: 0 }));
  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const queued = await execFileAsync(process.execPath, [cli, "enqueue-read", "--root", root,
    "--account", account, "--sku", "SKU-1", "--remote", "existing-product", "--expected", expectedFile]);
  const { jobId } = JSON.parse(queued.stdout);
  const run = await execFileAsync(process.execPath, [cli, "run-read", "--root", root,
    "--account", account, "--job", jobId]);
  assert.equal(JSON.parse(run.stdout).status, "CONNECTOR_NOT_CONFIGURED");
  assert.equal((await listReadResults(root, jobId)).length, 1);
}));

test("observed edit labels yield only partial field evidence, never privacy or unlabeled quantity", async () => withRoot(async root => {
  const queued = await job(root);
  let url = "";
  let closed = false;
  const page = {
    goto: async next => { url = next; }, url: () => url,
    getByRole: (role, options) => ({ count: async () =>
      (role === "heading" && options.name === "商品管理") ||
      (role === "button" && options.name === "公開設定に進む") ? 1 : 0 }),
    locator: selector => ({ evaluateAll: async callback => {
      assert.equal(selector, "input, textarea");
      const prior = globalThis.HTMLInputElement;
      const priorDocument = globalThis.document;
      class FakeInput {
        constructor(label, value, type = "text") {
          this.value = value; this.type = type;
          this.parentElement = { parentElement: { querySelectorAll: selector =>
            selector === "label" ? [{ textContent: label }] : [this] } };
        }
      }
      globalThis.HTMLInputElement = FakeInput;
      globalThis.document = { location: { href: url } };
      try { return callback([
        new FakeInput("商品名", "QA title"),
        new FakeInput("商品の説明 任意", "QA description"),
        new FakeInput("商品管理コード 任意", "SKU-1"),
        new FakeInput("販売価格", "90,000"),
        new FakeInput("数量", "0", "number"),
        new FakeInput("購入可能数", "0", "number"),
        new FakeInput("パスワード", "should-not-return", "password"),
      ]); }
      finally { globalThis.HTMLInputElement = prior; globalThis.document = priorDocument; }
    } }),
  };
  const reader = createExistingProductReader({ root, profileDir: join(root, "profile"), shopId: account,
    launchPersistentContext: async () => ({ pages: () => [page], close: async () => { closed = true; } }) });
  const result = await runExistingRead(root, account, queued.jobId, reader);
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.comparison.account, "MATCH");
  assert.equal(result.comparison.remoteId, "MATCH");
  assert.equal(result.comparison.fields.inventoryCode, "MATCH");
  assert.equal(result.comparison.fields.title, "MATCH");
  assert.equal(result.comparison.fields.priceYen, "MATCH");
  assert.equal(result.comparison.fields.quantity, "UNOBSERVED");
  assert.equal(result.comparison.visibility, "UNOBSERVED");
  assert.equal(closed, true);
  assert.ok(!JSON.stringify(await listReadResults(root, queued.jobId)).includes("should-not-return"));
}));

test("a late exact heading is awaited, while absent field values remain unobserved", async () => withRoot(async root => {
  const queued = await job(root);
  let url = "";
  let headingReady = false;
  let waitOptions;
  let diagnostics;
  const page = {
    goto: async next => { url = next; }, url: () => url,
    getByRole: role => ({
      count: async () => role === "heading" ? Number(headingReady) : 1,
      first: () => ({ waitFor: async options => { waitOptions = options; headingReady = true; } }),
    }),
    locator: () => ({ evaluateAll: async () => ({ documentUrl: url, rows: [] }) }),
  };
  const reader = createExistingProductReader({ root, profileDir: join(root, "late-profile"), shopId: account,
    onReadDiagnostics: codes => { diagnostics = codes; },
    launchPersistentContext: async () => ({ pages: () => [page], close: async () => {} }) });
  const result = await runExistingRead(root, account, queued.jobId, reader);
  assert.equal(result.status, "INCOMPLETE");
  assert.deepEqual(waitOptions, { state: "visible", timeout: 12000 });
  assert.deepEqual(diagnostics, ["TITLE_UNOBSERVED", "DESCRIPTION_UNOBSERVED",
    "INVENTORY_CODE_UNOBSERVED", "PRICE_UNOBSERVED"]);
  assert.equal(result.comparison.fields.title, "UNOBSERVED");
  assert.equal(JSON.stringify(await listReadResults(root, queued.jobId)).includes("diagnostics"), false);
}));

test("a missing exact heading and a changed URL fail closed with fixed local diagnostics", async () => withRoot(async root => {
  const queued = await job(root);
  for (const mode of ["heading-timeout", "button-timeout", "url-changed", "signin-during-wait"]) {
    let url = "";
    let diagnostics;
    const page = {
      goto: async next => { url = next; }, url: () => url,
      getByRole: role => ({ count: async () =>
        (((mode === "heading-timeout" || mode === "signin-during-wait") && role === "heading") ||
        (mode === "button-timeout" && role === "button")) ? 0 : 1,
        first: () => ({ waitFor: async () => { const error = Error("private DOM text");
          if (mode === "signin-during-wait") url = "https://mercari-shops.com/signin/seller";
          error.name = "TimeoutError"; throw error; } }) }),
      locator: () => ({ evaluateAll: async () => {
        const documentUrl = url;
        url = "https://mercari-shops.com/seller/shops/other/products/other/edit";
        return { documentUrl, rows: [] };
      } }),
    };
    const reader = createExistingProductReader({ root, profileDir: join(root, `${mode}-profile`), shopId: account,
      onReadDiagnostics: codes => { diagnostics = codes; },
      launchPersistentContext: async () => ({ pages: () => [page], close: async () => {} }) });
    const result = await runExistingRead(root, account, queued.jobId, reader);
    assert.equal(result.status, mode === "signin-during-wait" ? "AUTH_REQUIRED" : "UNKNOWN");
    assert.deepEqual(diagnostics, mode === "signin-during-wait" ? undefined :
      [mode === "heading-timeout" ? "HEADING_TIMEOUT" :
        mode === "button-timeout" ? "NEXT_BUTTON_TIMEOUT" : "PAGE_URL_UNVERIFIED"]);
    assert.equal(JSON.stringify(result).includes("private DOM text"), false);
  }
}));

test("a redirect during field extraction discards target evidence", async () => withRoot(async root => {
  const queued = await job(root);
  for (const redirect of [
    "https://mercari-shops.com/signin/seller",
    "https://mercari-shops.com/seller/shops/other-shop/products/other-product/edit",
  ]) {
    let url = "";
    const page = {
      goto: async next => { url = next; }, url: () => url,
      getByRole: () => ({ count: async () => 1 }),
      locator: () => ({ evaluateAll: async () => {
        const documentUrl = url;
        url = redirect;
        return { documentUrl, rows: [
          { label: "商品名", value: "QA title" },
          { label: "商品管理コード", value: "SKU-1" },
        ] };
      } }),
    };
    const reader = createExistingProductReader({ root, profileDir: join(root, "profile"), shopId: account,
      launchPersistentContext: async () => ({ pages: () => [page], close: async () => {} }) });
    const result = await runExistingRead(root, account, queued.jobId, reader);
    assert.equal(result.status, redirect.includes("/signin/") ? "AUTH_REQUIRED" : "UNKNOWN");
    assert.equal(result.comparison, null);
  }
}));
