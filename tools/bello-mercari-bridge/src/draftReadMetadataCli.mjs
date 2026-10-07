import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeDraftReadMetadataOnce } from "./draftReadMetadataProbe.mjs";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const expectedOrigin =
  "https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com";
const fixed = status => ({ status, diagnostic: null,
  routeDiagnostic: "NO_ROUTE_BLOCK", routeBlockReasons: [],
  observations: [],
  closeStatus: "NOT_OPENED", allowFinalCreate: false });

/** CLI takes no shop or draft ID argument; both stay within the dedicated PC. */
export async function runDraftReadMetadataCli(args, { read = readFile,
  probe = probeDraftReadMetadataOnce } = {}) {
  if (args?.length !== 3 || args[0] !== "--config" ||
      !isAbsolute(args[1] ?? "") ||
      args[2] !== "--confirm-readonly-draft-metadata")
    return fixed("OPT_IN_REQUIRED");
  try {
    const config = JSON.parse(await read(args[1], "utf8"));
    const expectedDataDir = resolve(process.env.LOCALAPPDATA ?? "",
      "BELLO", "MercariBridge");
    if (config?.origin !== expectedOrigin ||
        typeof config.dataDir !== "string" ||
        !isAbsolute(config.dataDir) ||
        resolve(config.dataDir).toLowerCase() !== expectedDataDir.toLowerCase() ||
        config.createTestObservationEnabled !== false)
      return fixed("CONFIG_UNVERIFIED");
    const root = join(config.dataDir, "Queue");
    const account = JSON.parse(await read(join(root, "account.json"), "utf8"));
    if (account?.schemaVersion !== 1 || typeof account.accountReference !== "string" ||
        !ID.test(account.accountReference)) return fixed("ACCOUNT_UNVERIFIED");
    return await probe({ root, profileDir: join(config.dataDir, "ShopsChrome"),
      playwrightModulePath: join(fileURLToPath(new URL("..", import.meta.url)),
        "node_modules", "playwright", "package.json"),
      shopId: account.accountReference, confirmReadOnly: true,
      expectedRowCount: 12, rowIndex: 0 });
  } catch { return fixed("CONFIG_UNVERIFIED"); }
}

if (process.argv[1] &&
    fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  const result = await runDraftReadMetadataCli(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + "\n");
  if (!["DRAFT_UI_READ_OBSERVED", "NO_QUERY_METADATA"].includes(result.status))
    process.exitCode = 1;
}
