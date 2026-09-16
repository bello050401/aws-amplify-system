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
  const TIERS = [
    ["economy", "economy（軽い定型作業）"],
    ["standard", "standard（通常の作業）"],
    ["advanced", "advanced（設計・複雑な調査）"],
  ];
  const CAPABILITIES = [
    ["text", "text"],
    ["code", "code"],
    ["browser", "browser"],
    ["reasoning", "reasoning"],
  ];
  let snapshot;
  let queuedTasks = [];
  let selectedRunId = null;

  Object.entries(labels).forEach(([key, text]) => {
    const label = document.createElement("label"),
      input = document.createElement("input");
    input.type = "checkbox";
    input.id = "eco-" + key;
    input.disabled = key === "productionApproval";
    label.append(input, document.createTextNode(text));
    byId("eco-fields").append(label, document.createElement("br"));
  });

  TIERS.forEach(([tier, tierLabel]) => {
    const wrap = document.createElement("div");
    const heading = document.createElement("h4");
    heading.className = "sub-title";
    heading.textContent = tierLabel;
    wrap.append(heading);

    const providerLabel = document.createElement("label");
    providerLabel.setAttribute("for", "eco-mp-" + tier + "-provider");
    providerLabel.textContent = "プロバイダ";
    const providerSelect = document.createElement("select");
    providerSelect.id = "eco-mp-" + tier + "-provider";
    [["", "未設定"], ["claude", "Claude"], ["codex", "Codex"]].forEach(([value, text]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      providerSelect.append(option);
    });
    wrap.append(providerLabel, providerSelect);

    const modelLabel = document.createElement("label");
    modelLabel.setAttribute("for", "eco-mp-" + tier + "-model");
    modelLabel.textContent = "モデル名";
    const modelInput = document.createElement("input");
    modelInput.type = "text";
    modelInput.id = "eco-mp-" + tier + "-model";
    modelInput.autocomplete = "off";
    wrap.append(modelLabel, modelInput);

    const capRow = document.createElement("div");
    capRow.className = "row";
    CAPABILITIES.forEach(([cap, capText]) => {
      const capLabel = document.createElement("label");
      const capInput = document.createElement("input");
      capInput.type = "checkbox";
      capInput.id = "eco-mp-" + tier + "-cap-" + cap;
      capLabel.append(capInput, document.createTextNode(" " + capText));
      capRow.append(capLabel);
    });
    wrap.append(capRow);

    const note = document.createElement("p");
    note.className = "muted";
    note.id = "eco-mp-" + tier + "-note";
    wrap.append(note);

    byId("eco-model-policy").append(wrap);
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
    if (!response.ok) throw Error(data.error || "処理に失敗しました");
    return data;
  }

  function capabilityLabel(key) {
    return { browserQa: "ブラウザQA", claude: "Claude実行", staging: "staging接続" }[key] || key;
  }

  function renderCapabilities(capabilities) {
    const container = byId("eco-capabilities");
    container.textContent = "";
    Object.entries(capabilities || {}).forEach(([key, value]) => {
      const chip = document.createElement("span");
      chip.className = "chip " + (value?.connected ? "chip-ok" : "chip-bad");
      chip.textContent =
        capabilityLabel(key) + ": " + (value?.connected ? "接続済み" : "未接続" + (value?.reason ? "（" + value.reason + "）" : ""));
      container.append(chip);
    });
  }

  function reasoningAvailable(capabilities) {
    return capabilities?.reasoning?.connected === true;
  }

  function fillModelPolicyTier(tier, mapping, capabilities) {
    byId("eco-mp-" + tier + "-provider").value = mapping?.provider || "";
    byId("eco-mp-" + tier + "-model").value = mapping?.model || "";
    const caps = new Set(mapping?.capabilities || []);
    CAPABILITIES.forEach(([cap]) => {
      const input = byId("eco-mp-" + tier + "-cap-" + cap);
      input.checked = caps.has(cap);
      if (cap === "reasoning") {
        const available = reasoningAvailable(capabilities);
        input.disabled = !available;
        if (!available) input.checked = false;
      }
    });
    byId("eco-mp-" + tier + "-note").textContent = reasoningAvailable(capabilities)
      ? ""
      : "reasoning能力は、ホストで確認済みの接続がないため選択できません（偽装表示しません）。";
  }

  function readModelPolicyTier(tier) {
    const provider = byId("eco-mp-" + tier + "-provider").value;
    const model = byId("eco-mp-" + tier + "-model").value.trim();
    if (!provider || !model) return null;
    const capabilities = CAPABILITIES.filter(([cap]) => byId("eco-mp-" + tier + "-cap-" + cap).checked).map(([cap]) => cap);
    return { provider, model, capabilities };
  }

  async function loadQueuedTasks() {
    const data = await request("/api/tasks");
    queuedTasks = (data.tasks || []).filter((t) => t.state === "queued");
    const select = byId("eco-run-task");
    select.textContent = "";
    if (!queuedTasks.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "待機中のタスクはありません";
      select.append(option);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    queuedTasks.forEach((t) => {
      const option = document.createElement("option");
      option.value = t.id;
      option.textContent = t.id + " - " + t.title;
      select.append(option);
    });
  }

  async function loadPauseNote() {
    const health = await request("/api/health");
    byId("eco-pause-note").textContent = health.paused
      ? "システム全体が一時停止中です。ここでの登録は受け付け情報として保存されるだけで、停止は解除されません。"
      : "";
  }

  async function load() {
    snapshot = await request("/api/eco/settings");
    const config = snapshot.config;
    byId("eco-mode").value = config.mode;
    Object.keys(labels).forEach((key) => {
      byId("eco-" + key).checked = config[key];
    });
    byId("eco-repairs").value = config.maxRepairLoops;
    byId("eco-maxElapsedSeconds").value = config.maxElapsedSeconds;
    byId("eco-maxTokens").value = config.maxTokens;
    byId("eco-maxCostUsd").value = config.maxCostUsd;
    byId("eco-communicationRetries").value = config.communicationRetries;
    byId("eco-artifactRetries").value = config.artifactRetries;
    byId("eco-retentionDays").value = config.retentionDays;
    byId("eco-url").value = config.qaUrl;
    byId("eco-domains").value = config.allowedDomains.join(", ");
    byId("eco-account").value = config.testAccount;
    TIERS.forEach(([tier]) => fillModelPolicyTier(tier, config.modelPolicy?.[tier], snapshot.capabilities));
    dependencies();
    const anyConnected = Object.values(snapshot.capabilities || {}).some((c) => c?.connected);
    byId("eco-profile-note").textContent = anyConnected
      ? "接続済みの常駐サービスが承認したプロファイルIDのみ実行されます。誤ったIDは登録後に未接続として扱われます。"
      : "常駐サービスが未接続のため、どのプロファイルIDも現時点では実行されません（登録のみ可能です）。";
    byId("eco-save").disabled = !snapshot.writable;
    renderCapabilities(snapshot.capabilities);
    const reasons = Object.values(snapshot.capabilities || {})
      .filter((c) => !c.connected)
      .map((c) => c.reason);
    byId("eco-status").textContent =
      (snapshot.installed
        ? "設定 version " + snapshot.version + " / 稼働: " + (config.enabled ? "有効" : "無効")
        : "追加DBの適用前です。現在のタスクは従来どおり動作します。") +
      " / " +
      reasons.join(" / ");

    await Promise.all([loadQueuedTasks(), loadPauseNote(), loadRuns()]);
  }

  byId("eco-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!snapshot) return;
    byId("eco-save").disabled = true;
    const modelPolicy = {};
    TIERS.forEach(([tier]) => {
      modelPolicy[tier] = readModelPolicyTier(tier);
    });
    const config = {
      ...snapshot.config,
      mode: byId("eco-mode").value,
      maxRepairLoops: Number(byId("eco-repairs").value),
      maxElapsedSeconds: Number(byId("eco-maxElapsedSeconds").value),
      maxTokens: Number(byId("eco-maxTokens").value),
      maxCostUsd: Number(byId("eco-maxCostUsd").value),
      communicationRetries: Number(byId("eco-communicationRetries").value),
      artifactRetries: Number(byId("eco-artifactRetries").value),
      retentionDays: Number(byId("eco-retentionDays").value),
      qaUrl: byId("eco-url").value,
      allowedDomains: byId("eco-domains")
        .value.split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      testAccount: byId("eco-account").value,
      modelPolicy,
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

  byId("eco-register-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const taskId = byId("eco-run-task").value;
    if (!taskId) return;
    byId("eco-run-register").disabled = true;
    const acIds = byId("eco-run-acids")
      .value.split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    try {
      await request("/api/eco/runs", {
        taskId,
        profileId: byId("eco-run-profile").value.trim() || null,
        revision: byId("eco-run-revision").value.trim(),
        acIds,
        risk: byId("eco-run-risk").value,
        expectedVersion: snapshot.version,
        idempotencyKey: crypto.randomUUID(),
      });
      byId("eco-register-status").textContent = "登録しました。停止中の場合、実行は再開しません。";
      byId("eco-run-revision").value = "";
      byId("eco-run-acids").value = "";
      await Promise.all([loadQueuedTasks(), loadRuns()]);
    } catch (error) {
      byId("eco-register-status").textContent = error.message;
    } finally {
      byId("eco-operator").value = "";
      byId("eco-run-register").disabled = false;
    }
  });

  function fact(label, value) {
    const div = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    div.append(dt, dd);
    return div;
  }

  function renderArtifactSection(container, kind, label, artifact) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = label + (artifact ? "" : "（まだありません）");
    details.append(summary);
    if (artifact) {
      const pre = document.createElement("pre");
      pre.className = "pre";
      pre.textContent = JSON.stringify(artifact.body, null, 2);
      details.append(pre);
      if (artifact.evidenceRefs?.length) {
        const evidence = document.createElement("p");
        evidence.className = "muted";
        evidence.textContent = "証拠ファイル（相対path、リンクにはしません）: " + artifact.evidenceRefs.join(", ");
        details.append(evidence);
      }
    }
    container.append(details);
  }

  function renderMetrics(container, metrics) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "使用量・実測/推定/不明の区別";
    details.append(summary);
    const dl = document.createElement("dl");
    dl.className = "facts";
    dl.append(
      fact("トークン（実測）", String(metrics.tokens.measured)),
      fact("トークン（推定）", String(metrics.tokens.estimated)),
      fact("出典", metrics.tokens.source),
      fact("費用（API換算USD）", metrics.cost.known ? metrics.cost.valueUsd.toString() : "不明"),
      fact("再利用・節約", metrics.reuse.unknown ? "未計測" : String(metrics.reuse.reusedOperations)),
      fact("修正回数", String(metrics.repair.count)),
    );
    details.append(dl);
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = metrics.cost.note + " " + metrics.reuse.note;
    details.append(note);
    if (metrics.operations.note) {
      const opNote = document.createElement("p");
      opNote.className = "muted";
      opNote.textContent = metrics.operations.note;
      details.append(opNote);
    }
    container.append(details);
  }

  async function renderRunDetail(id) {
    const container = byId("eco-run-detail");
    container.textContent = "";
    container.classList.remove("hidden");
    let detail, metrics;
    try {
      [detail, metrics] = await Promise.all([
        request("/api/eco/runs/" + id),
        request("/api/eco/runs/" + id + "/metrics"),
      ]);
    } catch (error) {
      const err = document.createElement("p");
      err.className = "err";
      err.textContent = error.message;
      container.append(err);
      return;
    }
    const run = detail.run;
    const artifacts = detail.artifacts || [];
    const events = detail.events || [];
    const lastEvent = events[events.length - 1];

    const title = document.createElement("p");
    title.className = "big";
    title.textContent = run.id;
    container.append(title);

    const dl = document.createElement("dl");
    dl.className = "facts";
    dl.append(
      fact("phase / state", run.state),
      fact("対象タスク", run.task_id),
      fact("修正回数", String(run.repairCount ?? 0)),
      fact("通信エラー再試行", String(run.communicationFailures ?? 0)),
      fact("成果物エラー再試行", String(run.artifactFailures ?? 0)),
      fact("停止理由", lastEvent ? lastEvent.reason || "なし" : "なし"),
      fact("staging revision", run.headSHA || "未確定"),
      fact("staging デプロイID", run.deployment?.deploymentId || "未実施"),
    );
    container.append(dl);

    renderMetrics(container, metrics);

    const bySpec = artifacts.find((a) => a.id === run.specId);
    const byImpl = artifacts.find((a) => a.id === run.implementationId);
    const byInitialQa = artifacts.find((a) => a.id === run.initialQaId);
    const byFinalQa = artifacts.find((a) => a.id === run.finalQaId);
    renderArtifactSection(container, "spec", "仕様（spec）", bySpec);
    renderArtifactSection(container, "implementation", "実装（implementation）", byImpl);
    renderArtifactSection(container, "qa_initial", "QA（初回）", byInitialQa);
    renderArtifactSection(container, "qa_final", "QA（最終・受入結果）", byFinalQa);

    const eventDetails = document.createElement("details");
    const eventSummary = document.createElement("summary");
    eventSummary.textContent = "状態遷移の履歴";
    eventDetails.append(eventSummary);
    const list = document.createElement("ul");
    list.className = "plain-list";
    events.forEach((e) => {
      const li = document.createElement("li");
      li.textContent = e.timestamp + " " + (e.previousState || "-") + " -> " + e.nextState + " (" + e.actor + "): " + e.reason;
      list.append(li);
    });
    eventDetails.append(list);
    container.append(eventDetails);

    const actions = document.createElement("div");
    actions.className = "todo-actions";
    const terminal = ["COMPLETED_STAGING", "FAILED", "CANCELLED"].includes(run.state);
    [
      ["一時停止", "pause"],
      ["再開", "resume"],
      ["取り消し", "cancel"],
    ].forEach(([text, action]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-quiet";
      button.textContent = text;
      button.disabled = terminal;
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await request("/api/eco/control", {
            runId: run.id,
            expectedVersion: run.version,
            action,
            idempotencyKey: crypto.randomUUID(),
          });
          await Promise.all([loadRuns(), renderRunDetail(id)]);
        } catch (error) {
          byId("eco-register-status").textContent = error.message;
        } finally {
          byId("eco-operator").value = "";
          button.disabled = terminal;
        }
      });
      actions.append(button);
    });
    container.append(actions);
  }

  function renderRunsList(runs) {
    const container = byId("eco-runs-list");
    container.textContent = "";
    if (!runs.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "協調runはまだありません。";
      container.append(empty);
      return;
    }
    runs.forEach((r) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "link-btn";
      button.textContent = r.id + " / " + r.state + " / 修正 " + (r.repairCount ?? 0) + "回";
      button.addEventListener("click", () => {
        selectedRunId = r.id;
        renderRunDetail(r.id);
      });
      li.append(button);
      container.append(li);
    });
  }

  async function loadRuns() {
    const data = await request("/api/eco/runs");
    renderRunsList(data.runs || []);
    if (selectedRunId && data.runs?.some((r) => r.id === selectedRunId)) {
      await renderRunDetail(selectedRunId);
    }
  }

  load().catch((error) => {
    byId("eco-status").textContent = error.message;
    byId("eco-save").disabled = true;
  });
})();
