import { createRequire } from "node:module";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const MARKER = ".bello-admin-bridge-profile.json";

export function validBelloOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}

async function ensureProfile(profileDir, origin) {
  if (!profileDir || !isAbsolute(profileDir) || !validBelloOrigin(origin))
    throw Error("An absolute BELLO profile and HTTPS origin are required");
  await mkdir(profileDir, { recursive: true });
  const marker = join(profileDir, MARKER);
  try {
    const saved = JSON.parse(await readFile(marker, "utf8"));
    if (saved?.schemaVersion !== 1 || saved?.purpose !== "BELLO_ADMIN_BRIDGE" || saved?.origin !== origin)
      throw Error("This profile belongs to a different BELLO origin");
    return;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if ((await readdir(profileDir)).length !== 0)
    throw Error("Refusing to attach to an existing browser profile");
  const handle = await open(marker, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify({ schemaVersion: 1,
    purpose: "BELLO_ADMIN_BRIDGE", origin }) + "\n"); }
  finally { await handle.close(); }
}

/** Separate visible BELLO browser; the person signs in through BELLO's regular login page. */
export async function openBelloAdminContext({ origin, profileDir, playwrightModulePath,
  navigateToLogin = false, launchPersistentContext = null }) {
  await ensureProfile(profileDir, origin);
  let launch = launchPersistentContext;
  if (!launch) {
    if (!playwrightModulePath || !isAbsolute(playwrightModulePath))
      throw Error("An absolute Playwright module path is required");
    const playwright = createRequire(playwrightModulePath)("playwright");
    if (!playwright?.chromium?.launchPersistentContext) throw Error("Playwright Chrome is unavailable");
    launch = playwright.chromium.launchPersistentContext.bind(playwright.chromium);
  }
  const context = await launch(profileDir, { channel: "chrome", headless: false });
  if (!navigateToLogin) return context;
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${origin}/inventory/login`);
    return context;
  } catch (error) { await context.close(); throw error; }
}
