import assert from "node:assert/strict";
import { withEconveniAccount } from "../lib/listing/econveni/accountWorkflow";
import { EconveniHttpError } from "../lib/listing/econveni/httpSession";

async function main() {
  for (const failure of ["none", "lock", "secret", "login", "preflight", "network"] as const) {
    const calls: string[] = [];
    const store = {
      acquire: async () => { calls.push("lock"); if (failure === "lock") throw Error("busy"); },
      release: async () => { calls.push("release"); },
      stop: async (code: string) => { calls.push("stop:" + code); },
    };
    const session = {
      login: async () => { calls.push("login"); if (failure === "login") throw new EconveniHttpError("ADDITIONAL_AUTH"); },
      dispose: () => { calls.push("dispose"); },
    };
    const credential = async () => { calls.push("secret"); return failure === "secret" ? null : { loginId: "test", password: "test" }; };
    const operation = async () => {
      calls.push("preflight");
      if (failure === "preflight") throw new EconveniHttpError("ACCESS_DENIED");
      if (failure === "network") throw new EconveniHttpError("NETWORK");
      calls.push("operation"); return "done";
    };
    if (failure === "none") assert.equal(await withEconveniAccount(store, session, credential, operation), "done");
    else await assert.rejects(withEconveniAccount(store, session, credential, operation));
    if (failure === "lock") assert.deepEqual(calls, ["lock"]);
    else assert.deepEqual(calls.slice(-2), ["dispose", "release"]);
    const stop = calls.filter(c => c.startsWith("stop:"));
    assert.deepEqual(stop, failure === "secret" ? ["stop:AUTH_REQUIRED"] : failure === "login" ? ["stop:ADDITIONAL_AUTH"] : failure === "preflight" ? ["stop:ACCESS_DENIED"] : []);
    if (failure !== "none") assert.equal(calls.includes("operation"), false);
  }
  console.log("PASS: lock before credentials/login; auth and preflight denial persistently stop queue; no writes after denial; session destroyed; another worker's lock never released");
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
