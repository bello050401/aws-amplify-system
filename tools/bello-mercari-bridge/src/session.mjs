import { createRequire } from "node:module";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { join } from "node:path";
import { bindAccount } from "./queue.mjs";
import { observeShopsTraffic } from "./trafficObservation.mjs";
import { observeShopsReadQueries } from "./readQueryObservation.mjs";
import { observeExactReadForDirectProbe } from "./directReadProbeObserver.mjs";
import { observeFutureCreateTraffic } from "./futureCreateTrafficObservation.mjs";
import { claimFutureCreateObservationOnce } from "./futureCreateObservationAttempt.mjs";
import { PRIVATE_CREATE_SHOP_ID } from "./privateCreatePreparation.mjs";

const SIGN_IN_URL = "https://mercari-shops.com/signin/seller";
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

async function launchDedicatedProfile({ profileDir, playwrightModulePath,
  launchPersistentContext, serviceWorkersBlock = false,
  startOffline = false }) {
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
  return launch(profileDir, { channel: "chrome", headless: false,
    ...(serviceWorkersBlock ? { serviceWorkers: "block" } : {}),
    ...(startOffline ? { offline: true } : {}) });
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

/** Read-only launch to the observed product list; the user controls the normal create form. */
export async function openDedicatedProductListSession({ root, profileDir,
  playwrightModulePath, shopId, launchPersistentContext = null }) {
  if (typeof shopId !== "string" || !PRODUCT_ID.test(shopId) ||
      !root || !isAbsolute(root))
    throw Error("Invalid exact Shops list target");
  await bindAccount(root, shopId);
  const listUrl = `https://mercari-shops.com/seller/shops/${shopId}/products?tab=on_sale&visibility=unopened`;
  const context = await launchDedicatedProfile({ profileDir, playwrightModulePath,
    launchPersistentContext });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(listUrl);
    const actual = new URL(page.url());
    const state = actual.origin === "https://mercari-shops.com" &&
      actual.pathname.startsWith("/signin/") ? "AUTH_REQUIRED" :
      actual.href === listUrl ? "LIST_OPEN" : "UNKNOWN";
    return { context, page, state };
  } catch (error) {
    await context.close();
    throw error;
  }
}

/** A fresh page for a previously claimed generic form fill; restored tabs are never resumed. */
export async function openGeneralPrivateCreateFormSession({ root, profileDir,
  playwrightModulePath, shopId, claim, launchPersistentContext = null }) {
  if (shopId !== PRIVATE_CREATE_SHOP_ID || !root || !isAbsolute(root) ||
      claim?.status !== "UNKNOWN" || claim.shopId !== shopId ||
      !UUID.test(claim.inventoryId ?? "") || !UUID.test(claim.attemptId ?? ""))
    throw Error("GENERAL_FORM_SESSION_UNVERIFIED");
  await bindAccount(root, shopId);
  const context = await launchDedicatedProfile({ profileDir, playwrightModulePath,
    launchPersistentContext, serviceWorkersBlock: true, startOffline: true });
  try {
    if (typeof context.setOffline !== "function" ||
        typeof context.serviceWorkers !== "function" ||
        context.serviceWorkers().length !== 0)
      throw Error("GENERAL_FORM_OFFLINE_GUARD_UNAVAILABLE");
    const restored = context.pages();
    if (restored.some(candidate => candidate.url() !== "about:blank"))
      throw Error("RESTORED_SHOPS_PAGE_UNRESOLVED");
    const page = await context.newPage();
    for (const blank of restored) await blank.close();
    if (context.pages().some(candidate => candidate !== page))
      throw Error("UNEXPECTED_DEDICATED_BROWSER_PAGE");
    await context.setOffline(false);
    const listUrl = `https://mercari-shops.com/seller/shops/${shopId}/products?tab=on_sale&visibility=unopened`;
    await page.goto(listUrl);
    const actual = new URL(page.url());
    const state = actual.origin === "https://mercari-shops.com" &&
      actual.pathname.startsWith("/signin/") ? "AUTH_REQUIRED" :
      actual.href === listUrl ? "LIST_OPEN" : "UNKNOWN";
    return { context, page, state };
  } catch {
    await context.close().catch(() => {});
    throw Error("GENERAL_FORM_BROWSER_UNAVAILABLE");
  }
}

/** Opens a fresh tab in the existing dedicated profile for one metadata-only draft read. */
export async function openDraftMetadataReadSession({ root, profileDir,
  playwrightModulePath, shopId, requestGuard,
  onWebSocketBlocked = null,
  launchPersistentContext = null }) {
  if (typeof shopId !== "string" || !PRODUCT_ID.test(shopId) ||
      !root || !isAbsolute(root) || typeof requestGuard !== "function")
    throw Error("Invalid draft metadata target");
  const bound = JSON.parse(await readFile(join(root, "account.json"), "utf8"));
  if (bound?.schemaVersion !== 1 || bound.accountReference !== shopId)
    throw Error("Draft metadata account mismatch");
  const marker = JSON.parse(await readFile(join(profileDir, PROFILE_MARKER), "utf8"));
  if (marker?.schemaVersion !== 1 || marker.purpose !== "BELLO_MERCARI_DEDICATED")
    throw Error("Existing dedicated profile required");
  const context = await launchDedicatedProfile({ profileDir, playwrightModulePath,
    launchPersistentContext, serviceWorkersBlock: true, startOffline: true });
  try {
    if (typeof context.setOffline !== "function")
      throw Error("Draft metadata offline guard unavailable");
    if (typeof context.serviceWorkers !== "function" ||
        context.serviceWorkers().length !== 0)
      throw Error("Draft metadata service worker state unavailable");
    if (typeof context.route !== "function" ||
        typeof context.routeWebSocket !== "function")
      throw Error("Draft metadata context routing unavailable");
    await context.route("**/*", requestGuard);
    await context.routeWebSocket("**/*", ws => {
      try { onWebSocketBlocked?.(); } catch { /* Keep the socket blocked. */ }
      return ws.close();
    });
    const restoredPages = context.pages();
    if (restoredPages.some(candidate => candidate.url() !== "about:blank"))
      throw Error("Restored Shops page is unresolved");
    const page = await context.newPage();
    for (const restored of restoredPages) await restored.close();
    if (context.pages().some(candidate => candidate !== page))
      throw Error("Unexpected dedicated browser page");
    return { context, page };
  } catch {
    await context.close().catch(() => {});
    throw Error("Draft metadata browser unavailable");
  }
}

/** Isolated read page for a claimed visibility transition. Never resumes an old form. */
export async function openVisibilityTransitionSession({ root, profileDir,
  playwrightModulePath, shopId, launchPersistentContext = null }) {
  if (shopId !== PRIVATE_CREATE_SHOP_ID || !root || !isAbsolute(root))
    throw Error("Invalid visibility transition account");
  await bindAccount(root, shopId);
  const context = await launchDedicatedProfile({ profileDir, playwrightModulePath,
    launchPersistentContext });
  try {
    if (context.pages().some(candidate => {
      try {
        const url = new URL(candidate.url());
        return url.origin === "https://mercari-shops.com" &&
          (url.pathname === `/seller/shops/${shopId}/products/create` ||
            /^\/seller\/shops\/[^/]+\/products\/[^/]+\/edit$/.test(url.pathname));
      } catch { return false; }
    })) throw Error("Restored Shops form is unresolved");
    return { context, page: await context.newPage() };
  } catch {
    await context.close().catch(() => {});
    throw Error("VISIBILITY_BROWSER_UNAVAILABLE");
  }
}

/** One future target only: claim before opening Chrome because the create UI may autosave. */
export async function openFutureCreateTrafficObservationSession({ root, profileDir,
  playwrightModulePath, inventoryId, launchPersistentContext = null }) {
  const claim = await claimFutureCreateObservationOnce(root, inventoryId);
  let context;
  try {
    context = await launchDedicatedProfile({ profileDir, playwrightModulePath,
      launchPersistentContext });
  } catch {
    const error = Error("FUTURE_CREATE_BROWSER_UNAVAILABLE");
    error.claim = claim;
    throw error;
  }
  const closed = new Promise(resolve => context.once("close", resolve));
  let observer = null;
  try {
    const existingProductForm = context.pages().some(candidate => {
      try {
        const url = new URL(candidate.url());
        return url.origin === "https://mercari-shops.com" &&
          (url.pathname === `/seller/shops/${PRIVATE_CREATE_SHOP_ID}/products/create` ||
            /^\/seller\/shops\/[^/]+\/products\/[^/]+\/edit$/.test(url.pathname));
      } catch { return false; }
    });
    if (existingProductForm) throw Error("Existing remote product form is unknown");
    // Never navigate a restored tab that could carry a previous UNKNOWN draft or edit.
    const page = await context.newPage();
    await page.bringToFront?.();
    observer = observeFutureCreateTraffic(context, { page,
      shopId: PRIVATE_CREATE_SHOP_ID });
    const listUrl = `https://mercari-shops.com/seller/shops/${PRIVATE_CREATE_SHOP_ID}/products?tab=on_sale&visibility=unopened`;
    await page.goto(listUrl);
    const actual = new URL(page.url());
    const state = actual.origin === "https://mercari-shops.com" &&
      actual.pathname.startsWith("/signin/") ? "AUTH_REQUIRED" :
      actual.href === listUrl ? "LIST_OPEN" : "UNKNOWN";
    return { context, page, observer, claim, state, closed };
  } catch {
    await observer?.stop();
    await context.close();
    const error = Error("FUTURE_CREATE_BROWSER_UNAVAILABLE");
    // The caller must record UNKNOWN for this specific consumed claim.
    error.claim = claim;
    throw error;
  }
}

/** Opens only the observed exact-ID edit URL. Navigation alone never confirms identity or privacy. */
export async function openExistingProductReadSession({ root, profileDir, playwrightModulePath,
  shopId, remoteId, launchPersistentContext = null, observeTraffic = false,
  probeQuerySha256 = null, probeWaitMs = 12000 }) {
  if (!PRODUCT_ID.test(shopId) || !PRODUCT_ID.test(remoteId)) throw Error("Invalid existing Shops identity");
  if (!root || !isAbsolute(root)) throw Error("An absolute single-account queue root is required");
  await bindAccount(root, shopId);
  const expectedUrl = `https://mercari-shops.com/seller/shops/${shopId}/products/${remoteId}/edit`;
  const context = await launchDedicatedProfile({ profileDir, playwrightModulePath, launchPersistentContext });
  let traffic = null;
  let readQueries = null;
  let directReadProbe = null;
  try {
    const page = context.pages()[0] ?? await context.newPage();
    if (observeTraffic) {
      traffic = observeShopsTraffic(context);
      readQueries = observeShopsReadQueries(context, { shopId, remoteId, page });
    }
    if (probeQuerySha256)
      directReadProbe = observeExactReadForDirectProbe(context,
        { shopId, remoteId, page, querySha256: probeQuerySha256, waitMs: probeWaitMs });
    try { await page.goto(expectedUrl); }
    catch (error) {
      // A sign-in redirect can finish before its load event. Keep only the fixed auth state.
      let signIn = false;
      try {
        const current = new URL(page.url());
        signIn = current.origin === "https://mercari-shops.com" &&
          current.pathname.startsWith("/signin/");
      } catch { /* Preserve the original navigation failure. */ }
      if (signIn) return { context, page, state: "AUTH_REQUIRED",
        traffic, readQueries, directReadProbe };
      throw error;
    }
    const actual = new URL(page.url());
    const state = actual.origin === "https://mercari-shops.com" &&
      actual.pathname.startsWith("/signin/") ? "AUTH_REQUIRED" :
      actual.href === expectedUrl ? "NAVIGATED_UNVERIFIED" : "UNKNOWN";
    return { context, page, state, traffic, readQueries, directReadProbe };
  } catch (error) {
    traffic?.stop();
    await readQueries?.stop();
    directReadProbe?.stop();
    await context.close();
    throw error;
  }
}
