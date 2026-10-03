import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startDesktopApp } from "../src/desktopApp.mjs";

const config = () => ({ origin: "https://bello.example.test", requestId: "a".repeat(64),
  dataDir: join(tmpdir(), "bello-desktop-test") });
function context() {
  const events = new EventEmitter();
  events.close = async () => { events.emit("close"); };
  return events;
}
async function token(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return (await response.text()).match(/name="csrf" value="([a-f0-9]+)"/)[1];
}
const post = (url, csrf, action, origin = url) => fetch(`${url}/action`, {
  method: "POST", redirect: "manual", headers: { Origin: origin,
    "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ csrf, action }),
});

test("visible login steps use separate profiles; one explicit read binds the configured ID", async () => {
  const calls = [];
  const app = await startDesktopApp(config(), { openBrowser: async () => {},
    openBello: async (options) => { calls.push(["bello", options]); return context(); },
    openShops: async (options) => { calls.push(["shops", options]); return context(); },
    runRead: async (options) => { calls.push(["read", options]); return { status: "INCOMPLETE" }; } });
  try {
    const csrf = await token(app.url);
    assert.equal((await post(app.url, csrf, "read", "https://evil.example.test")).status, 403);
    assert.equal((await post(app.url, "wrong", "read")).status, 403);
    assert.equal((await post(app.url, csrf, "bello-login")).status, 303);
    assert.equal((await post(app.url, csrf, "shops-login")).status, 303);
    assert.equal((await post(app.url, csrf, "read")).status, 303);
    assert.equal(calls.length, 3);
    assert.notEqual(calls[0][1].profileDir, calls[1][1].profileDir);
    assert.equal(calls[2][1].requestId, config().requestId);
    assert.equal(calls[2][1].browserRead, true);
    const content = await (await fetch(app.url)).text();
    assert.match(content, /INCOMPLETE/);
    assert.match(content, /出品完了の確認ではありません/);
  } finally { await app.close(); }
});

test("a failed read never appears as a reported result", async () => {
  const app = await startDesktopApp(config(), { openBrowser: async () => {},
    runRead: async () => { throw Error("private cookie must not be shown"); } });
  try {
    const csrf = await token(app.url);
    assert.equal((await post(app.url, csrf, "read")).status, 303);
    const content = await (await fetch(app.url)).text();
    assert.match(content, /処理を完了できませんでした/);
    assert.equal(content.includes("private cookie"), false);
    assert.equal(content.includes("直近の結果"), false);
  } finally { await app.close(); }
});
