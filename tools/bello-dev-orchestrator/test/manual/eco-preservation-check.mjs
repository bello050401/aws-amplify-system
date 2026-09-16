import { DatabaseSync } from 'node:sqlite';
import { hash } from '../../src/eco/policy.mjs';
if (!process.argv[2] || !process.argv[3]) throw Error('Before backup and live DB paths required');
const before = new DatabaseSync(process.argv[2], { readOnly: true });
const live = new DatabaseSync(process.argv[3], { readOnly: true });
live.exec('BEGIN');
const result = {};
for (const table of ['tasks', 'task_state_history', 'todos']) {
  const rows = db => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  result[table] = { unchanged: hash(rows(before)) === hash(rows(live)), count: rows(live).length };
}
const paused = db => db.prepare("SELECT value FROM meta WHERE key='paused'").get()?.value;
result.pauseUnchanged = paused(before) === paused(live);
result.pause = { before: paused(before), after: paused(live) };
const lastHistory = before.prepare('SELECT MAX(id) AS id FROM task_state_history').get().id;
result.newTransitions = live.prepare('SELECT task_id,from_state,to_state,actor,at FROM task_state_history WHERE id>? ORDER BY id').all(lastHistory);
result.oldHistoryUnchanged = hash(before.prepare('SELECT * FROM task_state_history ORDER BY id').all()) === hash(live.prepare('SELECT * FROM task_state_history WHERE id<=? ORDER BY id').all(lastHistory));
result.ecoSchemaAppliedToLive = !!live.prepare("SELECT name FROM sqlite_master WHERE name='eco_config'").get();
live.exec('COMMIT'); before.close(); live.close();
console.log(JSON.stringify(result, null, 2));
