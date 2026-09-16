// Read-only source; ALL migrations run on a new temporary backup copy.
import { DatabaseSync, backup } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../src/store/db.mjs";
import { installEcoSchema } from "../../src/eco/store.mjs";
import { hash } from "../../src/eco/policy.mjs";
if (!process.argv[2]) throw Error("Read-only source DB path required");
const source = new DatabaseSync(path.resolve(process.argv[2]), {
  readOnly: true,
});
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bello-eco-migration-"));
const file = path.join(dir, "copy.sqlite");
await backup(source, file);
source.close();
const store = new Store(new DatabaseSync(file));
const tables = store
  .all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'eco_%' AND name<>'meta'",
  )
  .map((r) => r.name);
function snapshot(db) {
  return Object.fromEntries(
    tables.map((name) => [
      name,
      {
        count: db.get(`SELECT COUNT(*) AS n FROM "${name}"`).n,
        digest: hash(db.all(`SELECT * FROM "${name}" ORDER BY rowid`)),
      },
    ]),
  );
}
const before = snapshot(store),
  meta = store.all("SELECT * FROM meta ORDER BY key");
installEcoSchema(store);
installEcoSchema(store);
const after = snapshot(store);
const retained =
  hash(before) === hash(after) &&
  meta.every((r) => store.getMeta(r.key) === r.value);
store.close();
const reopened = new Store(new DatabaseSync(file, { readOnly: true }));
const restartRetained = hash(snapshot(reopened)) === hash(before);
const result = {
  sourceReadOnly: true,
  migratedCopy: file,
  retained,
  restartRetained,
  tables: Object.fromEntries(
    Object.entries(before).map(([name, r]) => [name, r.count]),
  ),
  integrity: reopened.integrityCheck(),
};
reopened.close();
console.log(JSON.stringify(result, null, 2));
if (!retained || !restartRetained || !result.integrity.ok) process.exitCode = 1;
