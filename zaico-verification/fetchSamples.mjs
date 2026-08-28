#!/usr/bin/env node
/**
 * ZAICO API sample-response fetcher — ONE-TIME, read-only reconnaissance.
 * This is NOT part of the BELLO app; it exists purely so the ZAICO→BELLO
 * sync's field mapping (lib/inventory/zaicoMapping.ts, not yet written)
 * can be built from a REAL ZAICO API response instead of a guess, per
 * the explicit instruction not to implement the mapping speculatively.
 *
 * Only ever issues GET requests. No POST/PUT/PATCH/DELETE is possible
 * from this file — there is no code path here that could write to
 * ZAICO, by construction, not just by convention.
 *
 * Run from the repo root:
 *   $env:ZAICO_API_TOKEN = "..." ; node zaico-verification/fetchSamples.mjs
 * (see the completion report for the exact one-block PowerShell command)
 *
 * SAFETY:
 * - The token is read from the ZAICO_API_TOKEN environment variable
 *   only — never hardcoded, never printed, never written to any output
 *   file. Only a short "token present, length N" confirmation is logged.
 * - Every HTTP response is saved to zaico-verification/output/*.json
 *   (gitignored — see zaico-verification/.gitignore) rather than dumped
 *   to the terminal, since a real inventory list can be large.
 * - A best-effort redaction pass replaces the VALUE of any key that
 *   looks like personal-information (name/phone/email/address, English
 *   or Japanese) with "[REDACTED]" before saving — key names are always
 *   kept, since those are exactly what this script exists to discover.
 *   This is a safety net for a product/furniture inventory API, not a
 *   guarantee for arbitrary data; skim the saved files yourself before
 *   sharing them further if you have any doubt.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "output");

// Overridable in case your own prior zaico-verification/ setup already
// established the correct base URL — this is the current publicly
// documented convention, not something re-confirmed from a live call
// (that's the whole point of this script).
const BASE_URL = process.env.ZAICO_API_BASE_URL ?? "https://web.zaico.co.jp/api/v1";
const SAMPLE_INVENTORY_ID = process.env.ZAICO_SAMPLE_INVENTORY_ID ?? "73638418";
const TOKEN = process.env.ZAICO_API_TOKEN;

// Deliberately NOT "name" (English) or "氏名"/"名前" (Japanese) — those
// substrings match far too much of ZAICO's own field/attribute
// structure to be a useful PII signal here: `optional_attributes[].name`
// is the actual ZAICO field LABEL ("販売価格" etc, exactly what this
// script exists to discover, see the incident this comment documents),
// and the inventory's own `name`/`title` is the product name, not a
// person's. This inventory is furniture stock, not customer records, so
// the realistic residual risk is a 仕入先/取引先 contact detail — this
// list stays narrow (phone/email/address-shaped keys only) rather than
// broad, on purpose.
const PII_KEY_PATTERN = /(\btel\b|phone|email|\bmail\b|address|\bzip\b|postal|住所|電話|郵便)/i;
// These are structural keys ZAICO's API itself uses everywhere (an
// optional_attribute's {name, value} pair, in particular) — never
// redacted regardless of PII_KEY_PATTERN, so a future broadening of that
// pattern can't accidentally catch them again the way "name" just did.
const NEVER_REDACT_KEYS = new Set(["name", "value", "title", "id"]);

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      const shouldRedact = !NEVER_REDACT_KEYS.has(key) && PII_KEY_PATTERN.test(key) && (typeof v === "string" || typeof v === "number");
      out[key] = shouldRedact ? "[REDACTED]" : redact(v);
    }
    return out;
  }
  return value;
}

async function fetchAndSave(label, url) {
  process.stdout.write(`Fetching ${label} … `);
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
    });
  } catch (err) {
    console.log(`network error: ${err instanceof Error ? err.message : String(err)}`);
    await writeFile(path.join(OUTPUT_DIR, `${label}-error.txt`), String(err), "utf8");
    return;
  }

  const status = res.status;
  const contentType = res.headers.get("content-type") ?? "";
  let bodyText;
  try {
    bodyText = await res.text();
  } catch (err) {
    bodyText = `<failed to read body: ${err instanceof Error ? err.message : String(err)}>`;
  }

  let saved;
  if (contentType.includes("application/json")) {
    try {
      const json = JSON.parse(bodyText);
      saved = JSON.stringify(redact(json), null, 2);
    } catch {
      saved = bodyText; // claimed JSON but didn't parse — save as-is for inspection
    }
  } else {
    saved = bodyText;
  }

  const ext = contentType.includes("application/json") ? "json" : "txt";
  const outPath = path.join(OUTPUT_DIR, `${label}.${ext}`);
  await writeFile(outPath, saved, "utf8");
  console.log(`HTTP ${status} → ${path.relative(process.cwd(), outPath)} (${saved.length} bytes)`);
}

async function main() {
  if (!TOKEN) {
    console.error(
      "ZAICO_API_TOKEN is not set. Set it as an environment variable first (never hardcode it) — see the completion report for the exact command.",
    );
    process.exit(1);
  }
  // Which of the three to actually fetch — `node fetchSamples.mjs detail`
  // fetches only the detail sample (no need to re-pull the ~2MB list
  // response just to re-run the redaction fix over one field). No
  // arguments = all three, the original default.
  const requested = process.argv.slice(2);
  const targets = requested.length > 0 ? new Set(requested) : new Set(["detail", "list", "attachments"]);

  console.log(`Using token: present (length ${TOKEN.length}); base URL: ${BASE_URL}; sample inventory ID: ${SAMPLE_INVENTORY_ID}; targets: ${[...targets].join(", ")}`);
  await mkdir(OUTPUT_DIR, { recursive: true });

  // Small delay between calls — good practice even for a handful of
  // requests, given ZAICO's documented per-second rate limit for the
  // real sync later.
  if (targets.has("detail")) {
    await fetchAndSave("inventory-detail", `${BASE_URL}/inventories/${SAMPLE_INVENTORY_ID}`);
    await new Promise((r) => setTimeout(r, 400));
  }

  if (targets.has("list")) {
    await fetchAndSave("inventory-list-sample", `${BASE_URL}/inventories?limit=5`);
    await new Promise((r) => setTimeout(r, 400));
  }

  if (targets.has("attachments")) {
    // Endpoint path guessed (attachments/images are commonly separate
    // from the core inventory resource) — confirmed 401 in practice; the
    // image URL is inline on the detail/list response instead
    // (`item_image.url`), which is what the sync actually uses. Kept
    // here only so re-running with no arguments still records that.
    await fetchAndSave("inventory-attachments", `${BASE_URL}/inventories/${SAMPLE_INVENTORY_ID}/attachments`);
  }

  console.log("\nDone. Every response (or error) is saved under zaico-verification/output/ — never printed here, never committed (gitignored).");
  console.log("Please paste the contents of those files back so the ZAICO→BELLO field mapping can be built from them.");
}

main();
