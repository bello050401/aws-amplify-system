import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { openDraftMetadataReadSession } from "../src/session.mjs";

const shopId = "evkhihBFFNn5hukMS9s36H";

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
      launchPersistentContext: async () => { launched = true; } }));
    assert.equal(launched, false);
    await writeFile(join(profileDir, ".bello-mercari-bridge-profile.json"),
      JSON.stringify({ schemaVersion: 1, purpose: "BELLO_MERCARI_DEDICATED" }));
    let options = null;
    const context = { serviceWorkers: () => [], pages: () => [],
      newPage: async () => ({ url: () => "about:blank" }),
      close: async () => {} };
    const session = await openDraftMetadataReadSession({ root, profileDir,
      playwrightModulePath: join(temp, "playwright", "package.json"), shopId,
      launchPersistentContext: async (_profile, launchOptions) => {
        options = launchOptions; return context;
      } });
    assert.equal(session.context, context);
    assert.equal(options.serviceWorkers, "block");
    assert.equal(options.headless, false);
    await context.close();
    let closed = false;
    const restored = { ...context, pages: () => [{ url: () =>
      `https://mercari-shops.com/seller/shops/${shopId}/products/create?productDraftId=draft123` }],
    close: async () => { closed = true; } };
    await assert.rejects(openDraftMetadataReadSession({ root, profileDir,
      playwrightModulePath: join(temp, "playwright", "package.json"), shopId,
      launchPersistentContext: async () => restored }));
    assert.equal(closed, true);
    let restoredListClosed = false;
    await assert.rejects(openDraftMetadataReadSession({ root, profileDir,
      playwrightModulePath: join(temp, "playwright", "package.json"), shopId,
      launchPersistentContext: async () => ({ ...context,
        pages: () => [{ url: () =>
          `https://mercari-shops.com/seller/shops/${shopId}/products?tab=draft` }],
        close: async () => { restoredListClosed = true; } }) }));
    assert.equal(restoredListClosed, true);
    let workerContextClosed = false;
    await assert.rejects(openDraftMetadataReadSession({ root, profileDir,
      playwrightModulePath: join(temp, "playwright", "package.json"), shopId,
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
