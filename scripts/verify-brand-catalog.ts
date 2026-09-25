import assert from "node:assert/strict";
import catalog from "../lib/brands/catalog.generated.json";

const names = new Set<string>();
const ids = new Set<string>();
const allowedHosts = new Set(["img.tabroom.jp", "dopa.co.jp", "www.dopa.co.jp"]);
for (const brand of catalog) {
  assert.ok(brand.name.trim(), "brand name is required");
  assert.ok(brand.description.trim(), `${brand.name}: reference text is required`);
  assert.ok(!names.has(brand.name.trim().toLocaleLowerCase()), `${brand.name}: duplicate name`);
  assert.ok(!ids.has(brand.id), `${brand.name}: duplicate id`);
  names.add(brand.name.trim().toLocaleLowerCase());
  ids.add(brand.id);
  const logo = new URL(brand.logoUrl);
  assert.equal(logo.protocol, "https:", `${brand.name}: logo must use HTTPS`);
  assert.ok(allowedHosts.has(logo.hostname), `${brand.name}: logo host is not allowed`);
}
assert.equal(catalog.length, 750, "curated catalog unexpectedly changed size");
process.stdout.write(`Brand catalog checks passed (${catalog.length} entries).\n`);
