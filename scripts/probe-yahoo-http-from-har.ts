import { readFileSync, statSync } from "node:fs";
import { YahooWebSession } from "../lib/listing/yahooAuction/webHttpSession.ts";

// Operator-only: reads the explicitly supplied local capture. No browser profile,
// credential persistence, cloud upload, listing mutations or raw exception output.
async function main() {
  const source = process.argv[2];
  if (!source || process.argv.length !== 3 || statSync(source).size > 100 * 1024 * 1024) throw Error("INVALID_SOURCE");
  const opened = YahooWebSession.fromHar(JSON.parse(readFileSync(source, "utf8").replace(/^\uFEFF/, "")));
  if (!opened.ok) { process.stdout.write(JSON.stringify(opened) + "\n"); return; }
  const result = await opened.value.inspectInput();
  process.stdout.write(JSON.stringify({ transport: "HTTPS", execution: "LOCAL_NODE", checkedAt: new Date().toISOString(), ...result }) + "\n");
}
main().catch(() => { process.stdout.write('{"ok":false,"code":"LOCAL_CAPTURE_UNAVAILABLE"}\n'); process.exitCode = 1; });
