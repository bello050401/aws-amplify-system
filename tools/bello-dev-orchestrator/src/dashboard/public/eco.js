/* Settings are not overwritten by the legacy periodic refresh. */
(function () {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const labels = {
    enabled: "新規runで有効にする",
    gptBrowserQa: "GPTによるブラウザQA",
    claudeImplementation: "Claudeによる実装",
    modelAutoRouting: "モデルの自動選択",
    contextCache: "読込要約の再利用",
    rereadPrevention: "同じファイルの再読込を抑える",
    stagingAutoDeploy: "検証環境へ自動反映",
    productionApproval: "本番反映は人間の承認が必要（固定）",
  };
  let snapshot;
  Object.entries(labels).forEach(([key, text]) => {
    const label = document.createElement("label"),
      input = document.createElement("input");
    input.type = "checkbox";
    input.id = "eco-" + key;
    input.disabled = key === "productionApproval";
    label.append(input, document.createTextNode(text));
    byId("eco-fields").append(label, document.createElement("br"));
  });
  function dependencies() {
    byId("eco-rereadPrevention").disabled = !byId("eco-contextCache").checked;
    if (!byId("eco-contextCache").checked)
      byId("eco-rereadPrevention").checked = false;
  }
  byId("eco-contextCache").addEventListener("change", dependencies);
  async function request(route, body) {
    const headers = { "x-bello-request": "1" };
    const lanToken = new URLSearchParams(location.search).get("token");
    if (lanToken) headers["x-bello-token"] = lanToken;
    if (body) {
      headers["Content-Type"] = "application/json";
      headers["x-bello-eco-operator"] = byId("eco-operator").value;
    }
    const response = await fetch(route, {
      method: body ? "POST" : "GET",
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "保存に失敗しました");
    return data;
  }
  async function load() {
    snapshot = await request("/api/eco/settings");
    const config = snapshot.config;
    byId("eco-mode").value = config.mode;
    Object.keys(labels).forEach((key) => {
      byId("eco-" + key).checked = config[key];
    });
    byId("eco-repairs").value = config.maxRepairLoops;
    byId("eco-url").value = config.qaUrl;
    byId("eco-domains").value = config.allowedDomains.join(", ");
    byId("eco-account").value = config.testAccount;
    dependencies();
    byId("eco-save").disabled = !snapshot.writable;
    const reasons = Object.values(snapshot.capabilities)
      .filter((c) => !c.connected)
      .map((c) => c.reason);
    byId("eco-status").textContent =
      (snapshot.installed
        ? "設定 version " + snapshot.version
        : "追加DBの適用前です。現在のタスクは従来どおり動作します。") +
      " / " +
      reasons.join(" / ");
    const data = await request("/api/eco/runs");
    byId("eco-runs").textContent = data.runs.length
      ? data.runs
          .map((r) => r.id + ": " + r.state + " / 修正 " + r.repairCount + "回")
          .join("\n")
      : "協調runはまだありません。";
  }
  byId("eco-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!snapshot) return;
    byId("eco-save").disabled = true;
    const config = {
      ...snapshot.config,
      mode: byId("eco-mode").value,
      maxRepairLoops: Number(byId("eco-repairs").value),
      qaUrl: byId("eco-url").value,
      allowedDomains: byId("eco-domains")
        .value.split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      testAccount: byId("eco-account").value,
    };
    Object.keys(labels).forEach((key) => {
      config[key] = byId("eco-" + key).checked;
    });
    config.productionApproval = true;
    try {
      await request("/api/eco/settings", {
        config,
        expectedVersion: snapshot.version,
        idempotencyKey: crypto.randomUUID(),
      });
      await load();
      byId("eco-status").textContent +=
        " / 保存しました。停止状態は維持しています。";
    } catch (error) {
      byId("eco-status").textContent = error.message;
    } finally {
      byId("eco-operator").value = "";
      byId("eco-save").disabled = !snapshot.writable;
    }
  });
  load().catch((error) => {
    byId("eco-status").textContent = error.message;
    byId("eco-save").disabled = true;
  });
})();
