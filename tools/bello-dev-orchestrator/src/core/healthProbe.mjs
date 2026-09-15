/**
 * HTTP ヘルスプローブ (QA-003)。
 *
 * 「プロセスが生きている」と「実際にイベントループと HTTP が応答する」は別物。
 * 2026-09-07 の障害では PID は生きていた (LISTEN のまま) が、GET への応答が
 * 3 秒で返らなかった。ここは常に有限時間で戻ることを最優先にする。
 *
 * 3 つの失敗形をすべて有限時間で見分ける:
 *   1. 正常応答            -> ok:true
 *   2. 接続拒否 (プロセス無し) -> ok:false, reachable:false, error:"ECONNREFUSED" 等
 *   3. TCP接続後に無応答     -> ok:false, reachable:false, error:"timeout"
 */
import http from "node:http";

/**
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {string} [opts.path]
 * @param {string|null} [opts.token] ダッシュボードの共有トークン (LAN 公開時のみ必要)。
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok:boolean, reachable:boolean, status:?number, body:?object, error:?string, latencyMs:number}>}
 */
export function probeHealth({ host, port, path = "/api/health", token = null, timeoutMs = 5000 }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) {
    return Promise.resolve({ ok: false, reachable: false, status: null, body: null, error: "invalid timeout", latencyMs: 0 });
  }
  host = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardGuard);
      resolve({ ...result, latencyMs: Date.now() - startedAt });
    };

    // ソケットタイムアウトに万一頼れない場合の保険。必ずこの時間内に戻る。
    const hardGuard = setTimeout(() => {
      try {
        req.destroy(new Error("hard timeout"));
      } catch {
        /* 既に終わっている */
      }
      finish({ ok: false, reachable: false, status: null, body: null, error: "timeout" });
    }, timeoutMs + 500);
    hardGuard.unref?.();

    const headers = {};
    if (token) headers["X-BELLO-Token"] = token;

    let req;
    try {
      req = http.get({ host, port, path, headers, timeout: timeoutMs }, (res) => {
        const chunks = [];
        let bytes = 0;
        res.on("data", (c) => {
          bytes += c.length;
          if (bytes > 65536) {
            finish({ ok: false, reachable: true, status: res.statusCode, body: null, error: "response too large" });
            res.destroy();
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          let body = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            body = null;
          }
          finish({
            ok: res.statusCode === 200 && body?.ok === true,
            reachable: true,
            status: res.statusCode,
            body,
            error: res.statusCode !== 200 ? `HTTP ${res.statusCode}` : body?.ok === true ? null : "invalid health response",
          });
        });
        res.on("error", (err) => {
          finish({ ok: false, reachable: true, status: res.statusCode ?? null, body: null, error: err.message });
        });
      });
    } catch (err) {
      finish({ ok: false, reachable: false, status: null, body: null, error: err.message });
      return;
    }

    // TCP接続はできたが応答が来ない場合 (接続後の無活動)。§ケース3 に対応。
    req.on("timeout", () => {
      req.destroy();
      finish({ ok: false, reachable: false, status: null, body: null, error: "timeout" });
    });
    // 接続自体を拒否された場合 (プロセス不在)。§ケース2 に対応。
    req.on("error", (err) => {
      finish({ ok: false, reachable: false, status: null, body: null, error: err.code || err.message });
    });
  });
}
