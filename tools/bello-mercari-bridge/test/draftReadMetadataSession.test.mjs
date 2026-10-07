import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { openDraftMetadataReadSession } from "../src/session.mjs";

const shopId = "evkhihBFFNn5hukMS9s36H";
const requestGuard = async () => {};

test("uses only the bound dedicated profile with service workers blocked", async () => {
  const temp = await mkdtemp(join(tmpdir(), "bello-draft-metadata-session-"));
  try {
    const root = join(temp, "Queue");
    const profileDir = join(temp, "ShopsChrome");
    await mkdir(root);
    await mkdir(profileDir);
    await writeFile(join(root, "account.json"), JSON.stringify({ schemaVersion: 1,
      accountReference: shopId }));
    let launched = false;
    await assert.rejects(openDraftMetadataReadSession({ root, profileDir,
      playwrightModulePath: join(temp, "playwright", "package.json"), shopId,
      requestGuard,
      launchPersistentContext: async () => { launched = true; } }));
    assert.equal(launched, false);
    await writeFile(join(profileDir, ".bello-mercari-bridge-profile.json"),
      JSON.stringify({ schemaVersion: 1, purpose: "BELLO_MERCARI_DEDICATED" }));
    let options = null;
    let startupWritePossible = false;
    let websocketHandler;
    let socketBlocks = 0;
    const lifecycle = [];
    const context = { serviceWorkers: () => [],
      route: async () => lifecycle.push("route"),
      routeWebSocket: async (_pattern, handler) => {
        lifecycle.push("websocket-route");
        websocketHandler = handler;
      },
      pages: () => { lifecycle.push("inspect-pages"); return []; },
      newPage: async () => ({ url: () => "about:blank" }),
      setOffline: async () => {},
      close: async () => {} };
    const session = await openDraftMetadataReadSession({ root, profileDir,
      playwrightModulePath: join(temp, "playwright", "package.json"), shopId,
      requestGuard, onWebSocketBlocked: () => { socketBlocks++; },
      launchPersistentContext: async (_profile, launchOptions) => {
        options = launchOptions;
        startupWritePossible = launchOptions.offline !== true;
        return context;
      } });
    assert.equal(session.context, context);
    assert.equal(options.serviceWorkers, "block");
    assert.equal(options.offline, true);
    assert.equal(startupWritePossible, false);
    assert.deepEqual(lifecycle.slice(0, 3),
      ["route", "websocket-route", "inspect-pages"]);
    assert.equal(options.headless, false);
    let socketClosed = false;
    await websocketHandler({ close: async () => { socketClosed = true; } });
    assert.equal(socketClosed, true);
    assert.equal(socketBlocks, 1);
    await context.close();
    let closed = false;
    const restored = { ...context, pages: () => [{ url: () =>
      `https://mercari-shops.com/seller/shops/${shopId}/products/create?productDraftId=draft123` }],
    close: async () => { closed = true; } };
    await assert.rejects(openDraftMetadataReadSession({ root, profileDir,
      playwrightModulePath: join(temp, "playwright", "package.json"), shopId,
      requestGuard,
      launchPersistentContext: async () => restored }));
    assert.equal(closed, true);
    let restoredListClosed = false;
    await assert.rejects(openDraftMetadataReadSession({ root, profileDir,
      playwrightModulePath: join(temp, "playwright", "package.json"), shopId,
      requestGuard,
      launchPersistentContext: async () => ({ ...context,
        pages: () => [{ url: () =>
          `https://mercari-shops.com/seller/shops/${shopId}/products?tab=draft` }],
        close: async () => { restoredListClosed = true; } }) }));
    assert.equal(restoredListClosed, true);
    let workerContextClosed = false;
    await assert.rejects(openDraftMetadataReadSession({ root, profileDir,
      playwrightModulePath: join(temp, "playwright", "package.json"), shopId,
      requestGuard,
      launchPersistentContext: async () => ({ ...context,
        serviceWorkers: () => [{}],
        close: async () => { workerContextClosed = true; } }) }));
    assert.equal(workerContextClosed, true);
  } finally {
    if (dirname(resolve(temp)) !== resolve(tmpdir()) ||
        !basename(temp).startsWith("bello-draft-metadata-session-"))
      throw Error("Unexpected test directory");
    await rm(temp, { recursive: true, force: true });
  }
});
