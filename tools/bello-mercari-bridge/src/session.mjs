import { createRequire } from "node:module";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { join } from "node:path";
import { bindAccount } from "./queue.mjs";
import { observeShopsTraffic } from "./trafficObservation.mjs";
import { observeShopsReadQueries } from "./readQueryObservation.mjs";

const SIGN_IN_URL = "https://mercari-shops.com/signin/seller";
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const PROFILE_MARKER = ".bello-mercari-bridge-profile.json";

async function ensureDedicatedProfile(profileDir) {
  await mkdir(profileDir, { recursive: true });
  const marker = join(profileDir, PROFILE_MARKER);
  try {
    const value = JSON.parse(await readFile(marker, "utf8"));
    if (value?.schemaVersion !== 1 || value?.purpose !== "BELLO_MERCARI_DEDICATED")
      throw Error("This is not a BELLO Mercari dedicated profile");
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if ((await readdir(profileDir)).length !== 0)
    throw Error("Refusing to attach to an existing browser profile");
  const handle = await open(marker, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, purpose: "BELLO_MERCARI_DEDICATED" }) + "\n"); }
  finally { await handle.close(); }
}

async function launchDedicatedProfile({ profileDir, playwrightModulePath, launchPersistentContext }) {
  if (!profileDir || !isAbsolute(profileDir)) throw Error("An absolute dedicated profile directory is required");
  await ensureDedicatedProfile(profileDir);
  let launch = launchPersistentContext;
  if (!launch) {
    if (!playwrightModulePath || !isAbsolute(playwrightModulePath))
      throw Error("An absolute Playwright module path is required");
    const playwright = createRequire(playwrightModulePath)("playwright");
    if (!playwright?.chromium?.launchPersistentContext) throw Error("Playwright persistent Chrome is unavailable");
    launch = playwright.chromium.launchPersistentContext.bind(playwright.chromium);
  }
  return launch(profileDir, { channel: "chrome", headless: false });
}

/** Opens a dedicated, visible Chrome profile. The merchant signs in; no existing IAB session is read or copied. */
export async function openDedicatedLogin({ profileDir, playwrightModulePath, launchPersistentContext = null }) {
  const context = await launchDedicatedProfile({ profileDir, playwrightModulePath, launchPersistentContext });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(SIGN_IN_URL);
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}

/** Opens only the observed exact-ID edit URL. Navigation alone never confirms identity or privacy. */
export async function openExistingProductReadSession({ root, profileDir, playwrightModulePath,
  shopId, remoteId, launchPersistentContext = null, observeTraffic = false }) {
  if (!PRODUCT_ID.test(shopId) || !PRODUCT_ID.test(remoteId)) throw Error("Invalid existing Shops identity");
  if (!root || !isAbsolute(root)) throw Error("An absolute single-account queue root is required");
  await bindAccount(root, shopId);
  const expectedUrl = `https://mercari-shops.com/seller/shops/${shopId}/products/${remoteId}/edit`;
  const context = await launchDedicatedProfile({ profileDir, playwrightModulePath, launchPersistentContext });
  let traffic = null;
  let readQueries = null;
  try {
    const page = context.pages()[0] ?? await context.newPage();
    if (observeTraffic) {
      traffic = observeShopsTraffic(context);
      readQueries = observeShopsReadQueries(context, { shopId, remoteId, page });
    }
    await page.goto(expectedUrl);
    const actual = new URL(page.url());
    const state = actual.origin === "https://mercari-shops.com" &&
      actual.pathname.startsWith("/signin/") ? "AUTH_REQUIRED" :
      actual.href === expectedUrl ? "NAVIGATED_UNVERIFIED" : "UNKNOWN";
    return { context, page, state, traffic, readQueries };
  } catch (error) {
    traffic?.stop();
    await readQueries?.stop();
    await context.close();
    throw error;
  }
}
