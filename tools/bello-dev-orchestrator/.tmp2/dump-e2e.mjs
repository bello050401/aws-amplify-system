import { loadConfig } from "../src/config.mjs";
import { Store } from "../src/store/db.mjs";
import { Repo } from "../src/store/repo.mjs";
const loaded = loadConfig();
const store = await Store.open(loaded.paths.dbFile);
const repo = new Repo(store);
const t = repo.listTasks({ limit: 20 }).find((x) => x.title.includes("E2E実証"));
console.log("state:", t.state, "attempts:", t.attempts, "session:", t.session_id);
const rep = t.report_id ? repo.getReport(t.report_id) : null;
console.log("--- 完了報告 ---");
console.log(JSON.stringify(rep?.report, null, 2));
console.log("--- チェックポイント (証拠ゲート) ---");
for (const c of store.all("SELECT phase,data,at FROM checkpoints WHERE task_id=? ORDER BY id", [t.id])) {
  console.log(c.at, c.phase, c.data.slice(0, 600));
}
store.close();
