import crypto from "node:crypto";
import { EcoStore } from "./store.mjs";
import { validateEco } from "./policy.mjs";

export const disconnected = () => ({
  browserQa: {
    connected: false,
    reason: "常駐サービスからのブラウザQA接続は未設定です",
  },
  claude: {
    connected: false,
    reason: "実行ファイルの存在だけでは認証・モデル能力を確認できません",
  },
  staging: {
    connected: false,
    reason: "協調runのrevision照合アダプターは未接続です",
  },
});

// A separate operator credential is required for ALL eco writes. There is no
// caller-supplied human role or approval endpoint accessible to agents.
export class EcoApi {
  constructor({
    store,
    operatorToken = "",
    capabilities = disconnected,
    engine = null,
  }) {
    this.repo = new EcoStore({ store, capabilities });
    this.operatorToken = operatorToken;
    this.engine = engine;
  }
  handle(method, route, body = {}, token = "") {
    if (method === "GET" && route === "/api/eco/settings") {
      const s = this.repo.settings();
      return {
        ...s,
        writable: !!this.operatorToken && s.installed,
        ...validateEco({ ...s.config, enabled: false }, s.capabilities),
        config: s.config,
      };
    }
    if (method === "GET" && route === "/api/eco/runs")
      return { runs: this.repo.list() };
    if (method !== "POST") throw Error("Unknown eco endpoint");
    const expected = crypto
      .createHash("sha256")
      .update(this.operatorToken)
      .digest();
    const actual = crypto.createHash("sha256").update(String(token)).digest();
    if (!this.operatorToken || !crypto.timingSafeEqual(actual, expected))
      throw Error("Operator authentication required");
    if (route === "/api/eco/settings")
      return this.repo.save(
        body.config,
        body.expectedVersion,
        body.idempotencyKey,
      );
    if (!this.engine) throw Error("Cooperative worker is not connected");
    if (route === "/api/eco/control")
      return this.engine.control(
        body.runId,
        body.expectedVersion,
        body.action,
        body.idempotencyKey,
      );
    throw Error("Operation is not connected");
  }
}
