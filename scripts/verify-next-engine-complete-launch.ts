import assert from "node:assert/strict";
import { completeNextEngineLaunch } from "../lib/listing/nextEngine/completeLaunch";

const input = { uid: "synthetic-uid", state: "synthetic-state", clientId: "synthetic-id", clientSecret: "synthetic-secret", expectedCompanyNeId: "123456", credentialVersionId: "version-a" };
const pair = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh" };

async function main() {
  const order: string[] = [];
  const deps = {
    preflight: async () => { order.push("preflight"); },
    exchange: async (value: typeof input) => { assert.deepEqual(value, input); order.push("exchange"); return pair; },
    verifyConfiguration: async () => { order.push("verify"); return input; },
    save: async (value: typeof pair) => { assert.deepEqual(value, pair); order.push("save"); },
    readBack: async () => { order.push("readBack"); return pair; },
  };
  await completeNextEngineLaunch(input, deps);
  assert.deepEqual(order, ["preflight", "exchange", "verify", "save", "readBack", "verify"]);

  let exchanged = false;
  await assert.rejects(completeNextEngineLaunch(input, {
    ...deps, preflight: async () => { throw new Error("synthetic-secret-unavailable"); },
    exchange: async () => { exchanged = true; return pair; },
  }));
  assert.equal(exchanged, false);
  await assert.rejects(completeNextEngineLaunch(input, { ...deps, readBack: async () => null }));
  await assert.rejects(completeNextEngineLaunch(input, { ...deps, readBack: async () => ({ ...pair, refreshToken: "wrong" }) }));
  let saved = false;
  await assert.rejects(completeNextEngineLaunch(input, { ...deps,
    verifyConfiguration: async () => ({ ...input, credentialVersionId: "version-b" }),
    save: async () => { saved = true; },
  }));
  assert.equal(saved, false, "Configuration change before save must block token writes");
  let checks = 0;
  await assert.rejects(completeNextEngineLaunch(input, { ...deps,
    verifyConfiguration: async () => ++checks === 1 ? input : { ...input, credentialVersionId: "version-b" },
  }), "Configuration change after save must not report success");
  await assert.rejects(completeNextEngineLaunch({ ...input, state: "" }, deps));
  console.log("Next Engine launch completion: preflight precedes exchange; read-back required for success.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
