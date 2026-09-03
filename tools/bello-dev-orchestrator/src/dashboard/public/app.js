/* BELLO 開発管理ダッシュボード クライアント
 *
 * 方針: 通常はホームを見るだけで状況が分かること。技術的な詳細は
 *       「詳細を開いたとき」だけ出す。
 *
 * XSS 対策: サーバから来た値は必ず textContent で入れる。innerHTML は使わない。
 * 通信失敗時は「成功したように見せない」。
 */
(function () {
  "use strict";

  var TZ = "Asia/Tokyo";
  var state = {
    view: "home",
    lastOk: null,
    token: new URLSearchParams(location.search).get("token"),
    historyFilter: "all",
    openTaskId: null,
    currentStartedAt: null,
  };

  // ------------------------------------------------------------ 小道具
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function fmt(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString("ja-JP", { timeZone: TZ, hour12: false });
    } catch (e) {
      return String(iso);
    }
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleTimeString("ja-JP", { timeZone: TZ, hour12: false });
    } catch (e) {
      return String(iso);
    }
  }

  /** 経過時間を「1時間23分45秒」の形にする。 */
  function elapsedText(fromIso) {
    if (!fromIso) return "—";
    var ms = Date.now() - new Date(fromIso).getTime();
    if (!isFinite(ms) || ms < 0) return "—";
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (h > 0) return h + "時間" + m + "分" + sec + "秒";
    if (m > 0) return m + "分" + sec + "秒";
    return sec + "秒";
  }

  /** 状態を「色 + 文字」で示すための対応表。色だけに頼らない。 */
  var STATE_TONE = {
    queued: "unknown",
    preflight: "warn",
    running: "warn",
    verifying: "warn",
    awaiting_ai_review: "warn",
    revision_required: "warn",
    awaiting_user: "bad",
    paused: "unknown",
    retry_wait: "warn",
    completed: "ok",
    failed: "bad",
    cancelled: "unknown",
  };

  function stateChip(task) {
    var tone = STATE_TONE[task.state] || "unknown";
    return el("span", "chip chip-" + tone, task.stateLabel || task.state);
  }

  function sourceLabel(source) {
    return (
      {
        user_ui: "画面から",
        user_document: "Word文書から",
        review_engine: "審査から",
        recovery: "復旧",
        system: "システム",
      }[source] || source
    );
  }

  function decisionLabel(decision) {
    return (
      {
        accept_and_continue: "合格（完了）",
        revision_required: "修正が必要",
        request_user_action: "ユーザー様の操作が必要",
        pause_for_user_review: "確認待ち",
        fail_safely: "中止",
      }[decision] || decision
    );
  }

  function headers(extra) {
    var h = extra || {};
    if (state.token) h["X-BELLO-Token"] = state.token;
    return h;
  }

  function api(path, options) {
    var opts = options || {};
    var init = { method: opts.method || "GET", headers: headers(opts.headers) };
    if (opts.method && opts.method !== "GET") {
      init.headers["X-BELLO-Request"] = "1";
      if (opts.body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(opts.body);
      }
    }
    if (opts.raw) {
      init.headers["X-BELLO-Request"] = "1";
      init.body = opts.raw;
      delete init.headers["Content-Type"];
    }
    return fetch(path, init)
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            throw new Error("サーバ応答を解釈できませんでした (HTTP " + res.status + ")");
          })
          .then(function (body) {
            if (!res.ok) throw new Error(body && body.error ? body.error : "HTTP " + res.status);
            setConnection(true);
            return body;
          });
      })
      .catch(function (err) {
        setConnection(false, err.message);
        throw err;
      });
  }

  function setConnection(ok, message) {
    var chip = byId("conn-state");
    chip.className = "chip " + (ok ? "chip-ok" : "chip-bad");
    chip.textContent = ok ? "接続 正常" : "接続 失敗";
    if (ok) {
      state.lastOk = new Date();
      byId("last-updated").textContent = "最終更新 " + fmtTime(state.lastOk.toISOString());
    } else {
      byId("last-updated").textContent = state.lastOk
        ? "最終更新 " + fmtTime(state.lastOk.toISOString()) + "（以降は更新できていません）"
        : "更新できていません: " + (message || "");
    }
  }

  // ------------------------------------------------------------ 画面切替
  function show(view) {
    state.view = view;
    var views = document.querySelectorAll(".view");
    for (var i = 0; i < views.length; i += 1) {
      views[i].classList.toggle("hidden", views[i].id !== "view-" + view);
    }
    var navs = document.querySelectorAll(".nav-item, .bnav-item");
    for (var j = 0; j < navs.length; j += 1) {
      if (navs[j].dataset.view === view) navs[j].setAttribute("aria-current", "page");
      else navs[j].removeAttribute("aria-current");
    }
    if (view !== "history") {
      state.openTaskId = null;
      byId("history-detail").classList.add("hidden");
    }
    window.scrollTo(0, 0);
    refresh();
  }

  // ============================================================== ホーム
  function renderHome(data) {
    renderTodoZone(data.openTodos || []);

    var runChip = byId("run-chip");
    if (data.paused) {
      runChip.className = "chip chip-unknown";
      runChip.textContent = "一時停止中";
      byId("run-note").textContent = "新しい作業は始めません。";
    } else if (data.currentTask) {
      runChip.className = "chip chip-warn";
      runChip.textContent = "作業中";
      byId("run-note").textContent = "";
    } else {
      runChip.className = "chip chip-ok";
      runChip.textContent = "待機中";
      byId("run-note").textContent = "次の指示を待っています。";
    }

    var hasCurrent = Boolean(data.currentTask);
    byId("current-empty").classList.toggle("hidden", hasCurrent);
    byId("current-body").classList.toggle("hidden", !hasCurrent);
    state.currentStartedAt = hasCurrent ? data.currentTask.startedAt : null;

    if (hasCurrent) {
      var t = data.currentTask;
      byId("current-title").textContent = t.title;
      byId("current-started").textContent = fmt(t.startedAt);
      byId("current-elapsed").textContent = elapsedText(t.startedAt);
      byId("current-phase").textContent = t.stateLabel || t.state;
      renderPipeline(data.pipeline);
      var note = data.pipeline && data.pipeline.note ? data.pipeline.note : "";
      if (data.pipeline && data.pipeline.revisionCount) {
        note +=
          "（修正 " + data.pipeline.revisionCount + " 回目 / 上限 " + data.pipeline.maxRevisions + " 回）";
      }
      byId("pipeline-note").textContent = note;
    }

    var nextList = clear(byId("next-list"));
    var queue = data.queueAhead || [];
    if (queue.length === 0) {
      nextList.appendChild(el("li", null, "予定されている作業はありません。"));
    } else {
      queue.forEach(function (task, i) {
        var li = el("li");
        li.appendChild(el("div", null, i + 1 + ". " + task.title));
        li.appendChild(el("div", "sub", sourceLabel(task.source) + " ・ 優先度 " + task.priority));
        nextList.appendChild(li);
      });
    }

    var recent = clear(byId("recent-list"));
    var finished = data.recentFinished || [];
    if (finished.length === 0) {
      recent.appendChild(el("li", null, "まだ完了した作業はありません。"));
    } else {
      finished.forEach(function (task) {
        var li = el("li");
        var head = el("div");
        head.appendChild(stateChip(task));
        head.appendChild(el("span", null, " " + task.title));
        li.appendChild(head);
        li.appendChild(el("div", "sub", fmt(task.finishedAt)));
        recent.appendChild(li);
      });
    }
  }

  function renderPipeline(pipeline) {
    var list = clear(byId("pipeline"));
    var steps = (pipeline && pipeline.steps) || [];
    steps.forEach(function (step, i) {
      var li = el("li", "is-" + step.status);
      var mark = step.status === "done" ? "完了" : step.status === "active" ? "進行中" : "これから";
      li.appendChild(el("div", "pipe-step", i + 1 + ". " + mark));
      li.appendChild(el("div", "pipe-name", step.label));
      list.appendChild(li);
    });
  }

  // -------------------------------------------------------------- TODO
  function renderTodoZone(todos) {
    var zone = byId("todo-zone");
    var body = clear(byId("todo-zone-body"));
    var open = todos.filter(function (t) {
      return t.status === "open";
    });

    if (open.length === 0) {
      zone.classList.remove("has-todo");
      byId("todo-zone-title").textContent = "ユーザー様の作業";
      body.appendChild(el("p", "empty", "現在、ユーザー様の作業はありません"));
      return;
    }

    zone.classList.add("has-todo");
    byId("todo-zone-title").textContent = "ユーザー様にお願いしたいこと（" + open.length + " 件）";
    open.forEach(function (todo) {
      body.appendChild(todoCard(todo));
    });
  }

  function todoCard(todo) {
    var card = el("div", "todo-card");
    card.appendChild(el("h3", "todo-head", todo.title));

    var meta = el("div", "todo-meta");
    if (todo.priority === "urgent") meta.appendChild(el("span", "chip chip-bad", "急ぎ"));
    meta.appendChild(el("span", "chip", todo.canUseIphone ? "iPhone でもできます" : "PC が必要です"));
    if (todo.estimatedMinutes) meta.appendChild(el("span", "chip", "約 " + todo.estimatedMinutes + " 分"));
    card.appendChild(meta);

    var why = el("div", "todo-block");
    why.appendChild(el("span", "label", "なぜ必要か"));
    why.appendChild(el("span", null, todo.reason));
    card.appendChild(why);

    var how = el("div", "todo-block");
    how.appendChild(el("span", "label", "していただくこと"));
    if (todo.steps && todo.steps.length) {
      var ol = el("ol", "todo-steps");
      todo.steps.forEach(function (s) {
        ol.appendChild(el("li", null, s));
      });
      how.appendChild(ol);
    } else {
      how.appendChild(el("span", null, todo.actionRequired || "—"));
    }
    card.appendChild(how);

    var done = el("div", "todo-block");
    done.appendChild(el("span", "label", "完了の目安"));
    done.appendChild(el("span", null, todo.completionCondition || "—"));
    card.appendChild(done);

    var answer = null;
    if (todo.answerRequired || todo.answerFormat === "text" || todo.answerFormat === "choice") {
      card.appendChild(el("label", null, "回答" + (todo.answerRequired ? "（必須）" : "（任意）")));
      if (todo.answerFormat === "choice" && todo.answerChoices && todo.answerChoices.length) {
        answer = el("select");
        answer.appendChild(el("option", null, ""));
        todo.answerChoices.forEach(function (c) {
          answer.appendChild(el("option", null, c));
        });
      } else {
        answer = el("textarea");
        answer.rows = 3;
      }
      card.appendChild(answer);
    }

    var msg = el("p", "muted");
    var actions = el("div", "todo-actions");

    var completeBtn = el("button", "btn btn-primary", "完了にする");
    completeBtn.type = "button";
    completeBtn.addEventListener("click", function () {
      completeBtn.disabled = true;
      msg.className = "muted";
      msg.textContent = "送信しています…";
      api("/api/todos/" + encodeURIComponent(todo.id) + "/complete", {
        method: "POST",
        body: { answer: answer ? answer.value : null },
      })
        .then(function (result) {
          msg.className = "ok";
          msg.textContent =
            "完了しました。" +
            (result.resumedTaskIds && result.resumedTaskIds.length ? "作業を再開します。" : "");
          refresh();
        })
        .catch(function (err) {
          completeBtn.disabled = false;
          msg.className = "err";
          msg.textContent = "完了にできません: " + err.message;
        });
    });
    actions.appendChild(completeBtn);

    var cancelBtn = el("button", "btn btn-quiet btn-sm", "これは不要");
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", function () {
      if (!window.confirm("この依頼を取り消します。よろしいですか？")) return;
      api("/api/todos/" + encodeURIComponent(todo.id) + "/cancel", { method: "POST", body: {} })
        .then(refresh)
        .catch(function (err) {
          msg.className = "err";
          msg.textContent = err.message;
        });
    });
    actions.appendChild(cancelBtn);

    card.appendChild(actions);
    card.appendChild(msg);
    return card;
  }

  // ============================================================ 開発履歴
  var FILTERS = {
    all: null,
    active: ["queued", "preflight", "running", "retry_wait"],
    review: ["verifying", "awaiting_ai_review"],
    revision: ["revision_required", "awaiting_user", "paused"],
    completed: ["completed"],
    failed: ["failed", "cancelled"],
  };

  function renderHistory(data) {
    var box = clear(byId("history-list"));
    var allow = FILTERS[state.historyFilter];
    var tasks = (data.tasks || []).filter(function (t) {
      return !allow || allow.indexOf(t.state) >= 0;
    });

    if (tasks.length === 0) {
      var empty = el("div", "empty", "この条件に当てはまる作業はありません。");
      empty.style.padding = "18px 20px";
      box.appendChild(empty);
      return;
    }

    tasks.forEach(function (task) {
      var row = el("button", "hist-row");
      row.type = "button";
      var main = el("div", "hist-main");
      main.appendChild(el("div", "hist-title", task.title));
      main.appendChild(el("div", "hist-sub", fmt(task.updatedAt) + " ・ " + sourceLabel(task.source)));
      row.appendChild(main);
      row.appendChild(stateChip(task));
      row.addEventListener("click", function () {
        openTaskDetail(task.id);
      });
      box.appendChild(row);
    });
  }

  function openTaskDetail(taskId) {
    state.openTaskId = taskId;
    api("/api/tasks/" + encodeURIComponent(taskId)).then(function (data) {
      var box = clear(byId("history-detail"));
      box.classList.remove("hidden");
      var task = data.task;

      box.appendChild(el("h2", "panel-title", task.title));
      var meta = el("div", "todo-meta");
      meta.appendChild(stateChip(task));
      meta.appendChild(el("span", "chip", sourceLabel(task.source)));
      if (task.revisionCount) meta.appendChild(el("span", "chip", "修正 " + task.revisionCount + " 回"));
      box.appendChild(meta);

      if (task.blockedReason) box.appendChild(el("p", "err", task.blockedReason));
      if (task.lastError) box.appendChild(el("p", "err", task.lastError));

      var facts = el("dl", "facts");
      [
        ["開始", fmt(task.startedAt)],
        ["終了", fmt(task.finishedAt)],
        ["変更ファイル", String((task.changedFiles || []).length) + " 件"],
      ].forEach(function (pair) {
        var d = el("div");
        d.appendChild(el("dt", null, pair[0]));
        d.appendChild(el("dd", null, pair[1]));
        facts.appendChild(d);
      });
      box.appendChild(facts);

      var reviews = data.reviews || [];
      var review = reviews[reviews.length - 1];
      if (review) {
        var rv = el("div", "todo-block");
        rv.appendChild(el("span", "label", "審査の結果"));
        rv.appendChild(el("span", null, decisionLabel(review.decision)));
        if (review.review && review.review.reason) rv.appendChild(el("p", "muted", review.review.reason));
        box.appendChild(rv);
      }

      function section(title, content) {
        var det = el("details", "sub");
        det.appendChild(el("summary", null, title));
        det.appendChild(
          el("pre", "pre", typeof content === "string" ? content : JSON.stringify(content, null, 2)),
        );
        box.appendChild(det);
      }
      section("指示内容", data.instruction || "（なし）");
      section("変更ファイル", (task.changedFiles || []).join("\n") || "（なし）");
      section("テスト結果", (data.report && data.report.tests) || "（なし）");
      section("Claude 審査の詳細", reviews.length ? reviews : "（なし）");
      section("完了報告", data.report || "（なし）");
      section(
        "Git 情報",
        [
          "分離方式: " + (task.isolation || "-"),
          "作業場所: " + (task.workDir || "-"),
          "専用ブランチ: " + (task.worktreeBranch || "（なし）"),
          "基準: " + (task.baseBranch || "-") + " @ " + (task.baseCommit || "-"),
          "開始コミット: " + (task.gitStartCommit || "-"),
          "終了コミット: " + (task.gitEndCommit || "-"),
        ].join("\n"),
      );
      section(
        "状態の記録（ログ）",
        (data.history || [])
          .map(function (h) {
            return (
              fmt(h.at) + "  " + (h.from_state || "-") + " → " + h.to_state + "  [" + h.actor + "]  " + (h.reason || "")
            );
          })
          .join("\n") || "（なし）",
      );

      var actions = el("div", "todo-actions");
      if (["failed", "cancelled"].indexOf(task.state) >= 0) {
        var retry = el("button", "btn btn-quiet", "もう一度実行する");
        retry.type = "button";
        retry.addEventListener("click", function () {
          api("/api/tasks/" + encodeURIComponent(task.id) + "/retry", { method: "POST", body: {} }).then(refresh);
        });
        actions.appendChild(retry);
      }
      if (["queued", "paused", "awaiting_user", "retry_wait", "revision_required"].indexOf(task.state) >= 0) {
        var cancel = el("button", "btn btn-danger", "この作業を取り消す");
        cancel.type = "button";
        cancel.addEventListener("click", function () {
          if (!window.confirm("この作業を取り消します。よろしいですか？")) return;
          api("/api/tasks/" + encodeURIComponent(task.id) + "/cancel", {
            method: "POST",
            body: { reason: "画面からの取消" },
          }).then(refresh);
        });
        actions.appendChild(cancel);
      }
      var close = el("button", "link-btn", "閉じる");
      close.type = "button";
      close.addEventListener("click", function () {
        state.openTaskId = null;
        byId("history-detail").classList.add("hidden");
      });
      actions.appendChild(close);
      box.appendChild(actions);
    });
  }

  // ========================================================== 指示を追加
  function renderDocuments(data) {
    var box = clear(byId("document-list"));
    var docs = data.documents || [];
    var orderOf = {};
    (data.queue || []).forEach(function (t, i) {
      if (t.documentId && !orderOf[t.documentId]) orderOf[t.documentId] = i + 1;
    });

    if (docs.length === 0) {
      box.appendChild(el("p", "empty", "まだ取り込んだ文書はありません。"));
      return;
    }

    var list = el("ul", "plain-list");
    docs.forEach(function (doc) {
      var li = el("li");
      var head = el("div");
      head.appendChild(el("span", null, doc.originalName + " "));
      head.appendChild(parseStateChip(doc));
      li.appendChild(head);

      var subParts = [fmt(doc.receivedAt)];
      if (orderOf[doc.id]) subParts.push("実行予定 " + orderOf[doc.id] + " 番目");
      else if ((doc.taskIds || []).length) subParts.push("実行済みまたは実行中");
      li.appendChild(el("div", "sub", subParts.join(" ・ ")));

      if (doc.errorMessage) li.appendChild(el("p", "err", doc.errorMessage));
      if (doc.hasImages) {
        li.appendChild(
          el("p", "muted", "画像が " + doc.imageCount + " 点あります。画像内の文字は読み取っていません。"),
        );
      }

      var row = el("div", "row");
      var preview = el("button", "link-btn", "読み取った内容を見る");
      preview.type = "button";
      preview.addEventListener("click", function () {
        api("/api/documents/" + encodeURIComponent(doc.id)).then(function (d) {
          var det = el("details", "sub");
          det.setAttribute("open", "open");
          det.appendChild(el("summary", null, "読み取った内容"));
          det.appendChild(el("pre", "pre", d.text || "（空）"));
          li.appendChild(det);
          preview.remove();
        });
      });
      row.appendChild(preview);

      if (doc.parseState === "extracted") {
        var convert = el("button", "btn btn-quiet btn-sm", "この内容で作業を追加する");
        convert.type = "button";
        convert.addEventListener("click", function () {
          convert.disabled = true;
          api("/api/documents/" + encodeURIComponent(doc.id) + "/convert", { method: "POST", body: {} })
            .then(refresh)
            .catch(function (err) {
              convert.disabled = false;
              window.alert("追加できません: " + err.message);
            });
        });
        row.appendChild(convert);
      }
      li.appendChild(row);
      list.appendChild(li);
    });
    box.appendChild(list);
  }

  function parseStateChip(doc) {
    var map = {
      received: ["chip", "受け取りました"],
      extracting: ["chip chip-warn", "読み取り中"],
      extracted: ["chip chip-ok", "読み取り済み"],
      converted: ["chip chip-ok", "作業に登録済み"],
      duplicate: ["chip", "同じ内容のため見送り"],
      error: ["chip chip-bad", "読み取れませんでした"],
    };
    var pair = map[doc.parseState] || ["chip", doc.parseState];
    return el("span", pair[0], pair[1]);
  }

  function uploadFile(file) {
    var status = byId("upload-status");
    if (!file) return;
    if (!/\.docx$/i.test(file.name)) {
      status.className = "err";
      status.textContent = "Word の .docx ファイルを選んでください。";
      return;
    }
    status.className = "muted";
    status.textContent = file.name + " を読み込んでいます…";
    file.arrayBuffer().then(function (buf) {
      api("/api/documents/upload?filename=" + encodeURIComponent(file.name), { method: "POST", raw: buf })
        .then(function () {
          status.className = "ok";
          status.textContent = file.name + " を取り込みました。現在の作業が終わり次第、順番に始めます。";
          refresh();
        })
        .catch(function (err) {
          status.className = "err";
          status.textContent = "取り込めません: " + err.message;
        });
    });
  }

  // ============================================================== 設定
  function renderReviewProvider(rp) {
    var box = clear(byId("review-provider-options"));
    var status = byId("review-provider-status");
    (rp.options || []).forEach(function (opt) {
      var row = el("div", "todo-card");
      var label = el("label");
      label.style.display = "flex";
      label.style.gap = "10px";
      label.style.alignItems = "flex-start";
      label.style.marginTop = "0";
      label.style.color = "inherit";
      label.style.fontSize = "14px";
      label.style.cursor = "pointer";

      var radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "review-provider";
      radio.value = opt.value;
      radio.checked = opt.value === rp.current;
      radio.style.width = "auto";
      radio.style.minHeight = "0";
      radio.style.marginTop = "5px";

      var text = el("div");
      text.appendChild(el("strong", null, opt.label + (opt.value === rp.current ? "（選択中）" : "")));
      text.appendChild(el("p", "muted", opt.description));
      if (opt.note) text.appendChild(el("p", "err", opt.note));

      label.appendChild(radio);
      label.appendChild(text);
      row.appendChild(label);

      radio.addEventListener("change", function () {
        if (!radio.checked) return;
        status.className = "muted";
        status.textContent = "切り替えています…";
        api("/api/settings/review-provider", { method: "POST", body: { provider: opt.value } })
          .then(function (r) {
            status.className = "ok";
            status.textContent = "「" + opt.label + "」に変更しました。";
            renderReviewProvider(r.reviewProvider || {});
          })
          .catch(function (err) {
            status.className = "err";
            status.textContent = "変更できません: " + err.message;
            refresh();
          });
      });

      box.appendChild(row);
    });
  }

  function renderAudit(entries) {
    var tbody = clear(document.querySelector("#audit-table tbody"));
    (entries || []).slice(0, 100).forEach(function (e) {
      var tr = el("tr");
      tr.appendChild(el("td", null, fmt(e.at)));
      tr.appendChild(el("td", null, e.actor));
      tr.appendChild(el("td", null, e.action));
      tr.appendChild(el("td", null, e.target || ""));
      tr.appendChild(el("td", null, (e.result || "") + (e.detail ? " / " + e.detail : "")));
      tbody.appendChild(tr);
    });
  }

  // ------------------------------------------------------------- 更新
  function refresh() {
    if (state.view === "home") {
      api("/api/home").then(renderHome).catch(function () {});
    } else if (state.view === "history") {
      api("/api/tasks").then(renderHistory).catch(function () {});
      if (state.openTaskId) openTaskDetail(state.openTaskId);
    } else if (state.view === "add") {
      api("/api/documents").then(renderDocuments).catch(function () {});
    } else if (state.view === "settings") {
      api("/api/settings")
        .then(function (r) {
          renderReviewProvider(r.reviewProvider || {});
          byId("settings-report").textContent = JSON.stringify(r.config, null, 2);
        })
        .catch(function () {});
      api("/api/audit")
        .then(function (d) {
          renderAudit(d.entries);
        })
        .catch(function () {});
    }
  }

  // ------------------------------------------------------------- 配線
  var navs = document.querySelectorAll(".nav-item, .bnav-item");
  for (var i = 0; i < navs.length; i += 1) {
    navs[i].addEventListener("click", function (ev) {
      show(ev.currentTarget.dataset.view);
    });
  }

  byId("btn-pause").addEventListener("click", function () {
    api("/api/control/pause", { method: "POST", body: {} }).then(refresh);
  });
  byId("btn-resume").addEventListener("click", function () {
    api("/api/control/resume", { method: "POST", body: {} }).then(refresh);
  });
  byId("btn-stop-current").addEventListener("click", function () {
    if (!window.confirm("いま進めている作業を安全に止めます。よろしいですか？")) return;
    api("/api/control/stop-current", { method: "POST", body: {} }).then(refresh);
  });

  byId("history-filter").addEventListener("click", function (ev) {
    var pill = ev.target.closest(".pill");
    if (!pill) return;
    state.historyFilter = pill.dataset.filter;
    var pills = document.querySelectorAll("#history-filter .pill");
    for (var k = 0; k < pills.length; k += 1) pills[k].classList.toggle("pill-on", pills[k] === pill);
    refresh();
  });

  (function wireAdd() {
    var zone = byId("dropzone");
    var input = byId("doc-file");

    zone.addEventListener("click", function () {
      input.click();
    });
    zone.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        input.click();
      }
    });
    input.addEventListener("change", function () {
      if (input.files && input.files[0]) uploadFile(input.files[0]);
      input.value = "";
    });

    ["dragenter", "dragover"].forEach(function (name) {
      zone.addEventListener(name, function (ev) {
        ev.preventDefault();
        zone.classList.add("is-over");
      });
    });
    ["dragleave", "drop"].forEach(function (name) {
      zone.addEventListener(name, function (ev) {
        ev.preventDefault();
        zone.classList.remove("is-over");
      });
    });
    zone.addEventListener("drop", function (ev) {
      var files = ev.dataTransfer && ev.dataTransfer.files;
      if (files && files[0]) uploadFile(files[0]);
    });
    // 画面外へのドロップでブラウザがファイルを開いてしまうのを防ぐ
    window.addEventListener("dragover", function (ev) {
      ev.preventDefault();
    });
    window.addEventListener("drop", function (ev) {
      ev.preventDefault();
    });

    byId("new-task-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var title = byId("nt-title").value.trim();
      var instruction = byId("nt-instruction").value.trim();
      var priority = parseInt(byId("nt-priority").value, 10);
      if (!title || !instruction) return;
      api("/api/tasks", { method: "POST", body: { title: title, instruction: instruction, priority: priority } })
        .then(function (r) {
          window.alert(r.created ? "追加しました。" : "同じ内容の作業が既にあります（二重には積みません）。");
          byId("new-task-form").reset();
          byId("nt-priority").value = "50";
          show("home");
        })
        .catch(function (err) {
          window.alert("追加できません: " + err.message);
        });
    });
  })();

  byId("btn-diagnose").addEventListener("click", function () {
    byId("system-report").textContent = "診断しています…";
    api("/api/control/diagnose", { method: "POST", body: {} })
      .then(function (r) {
        byId("system-report").textContent = JSON.stringify(r, null, 2);
      })
      .catch(function (err) {
        byId("system-report").textContent = "診断できません: " + err.message;
      });
  });

  show("home");

  // 経過時間は毎秒、その他は 10 秒ごとに更新する
  setInterval(function () {
    if (state.view === "home" && state.currentStartedAt) {
      byId("current-elapsed").textContent = elapsedText(state.currentStartedAt);
    }
  }, 1000);
  setInterval(refresh, 10000);
})();
