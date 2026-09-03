/* BELLO 開発管理ダッシュボード クライアント
 *
 * XSS 対策: サーバから来た値は必ず textContent で入れる。innerHTML は使わない。
 * 通信失敗時は「成功したように見せない」(指示書 §10-3)。
 */
(function () {
  "use strict";

  var TZ = "Asia/Tokyo";
  var state = { view: "home", lastOk: null, token: new URLSearchParams(location.search).get("token") };

  // ------------------------------------------------------------ utilities
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function fmt(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString("ja-JP", { timeZone: TZ, hour12: false });
    } catch (e) {
      return String(iso);
    }
  }

  function relative(iso) {
    if (!iso) return "";
    var diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (!isFinite(diff)) return "";
    if (diff < 60) return Math.round(diff) + " 秒前";
    if (diff < 3600) return Math.round(diff / 60) + " 分前";
    if (diff < 86400) return Math.round(diff / 3600) + " 時間前";
    return Math.round(diff / 86400) + " 日前";
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
    return fetch(path, init).then(function (res) {
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
    }).catch(function (err) {
      setConnection(false, err.message);
      throw err;
    });
  }

  function setConnection(ok, message) {
    var chip = document.getElementById("conn-state");
    chip.className = "chip " + (ok ? "chip-ok" : "chip-bad");
    chip.textContent = ok ? "接続 正常" : "接続 失敗: " + (message || "");
    if (ok) {
      state.lastOk = new Date();
      document.getElementById("last-updated").textContent = "最終更新: " + fmt(state.lastOk.toISOString());
    } else {
      document.getElementById("last-updated").textContent =
        "最終更新: " + (state.lastOk ? fmt(state.lastOk.toISOString()) + "（以降は更新できていません）" : "—");
    }
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function show(view) {
    state.view = view;
    var views = document.querySelectorAll(".view");
    for (var i = 0; i < views.length; i += 1) {
      views[i].classList.toggle("hidden", views[i].id !== "view-" + view);
    }
    var tabs = document.querySelectorAll(".tab");
    for (var j = 0; j < tabs.length; j += 1) {
      if (tabs[j].dataset.view === view) tabs[j].setAttribute("aria-current", "page");
      else tabs[j].removeAttribute("aria-current");
    }
    refresh();
  }

  // ----------------------------------------------------------------- home
  function renderHome(data) {
    document.getElementById("run-state").textContent = data.paused ? "一時停止中" : "稼働中";
    document.getElementById("current-task").textContent = data.currentTask ? data.currentTask.title : "なし";
    document.getElementById("current-heartbeat").textContent = data.lastHeartbeat
      ? "最終ハートビート: " + fmt(data.lastHeartbeat) + "（" + relative(data.lastHeartbeat) + "）"
      : "";
    document.getElementById("next-task").textContent = data.nextTask ? data.nextTask.title : "なし";

    var counts = clear(document.getElementById("counts"));
    var labels = data.stateLabels || {};
    var keys = Object.keys(data.counts || {});
    if (keys.length === 0) counts.appendChild(el("li", null, "タスクはまだありません"));
    keys.forEach(function (key) {
      var li = el("li");
      li.appendChild(el("span", null, labels[key] || key));
      li.appendChild(el("strong", null, data.counts[key]));
      counts.appendChild(li);
    });

    var banner = document.getElementById("todo-banner");
    if (data.openTodoCount > 0) {
      banner.classList.remove("banner-hidden");
      document.getElementById("todo-banner-count").textContent =
        "未完了 " + data.openTodoCount + " 件（うち緊急 " + data.urgentTodoCount + " 件）";
      var list = clear(document.getElementById("todo-banner-list"));
      (data.openTodos || []).slice(0, 5).forEach(function (todo) {
        var li = el("li");
        li.appendChild(el("strong", null, todo.title));
        li.appendChild(
          el(
            "span",
            "muted",
            "　" + (todo.priority === "urgent" ? "【緊急】" : "") +
              (todo.canUseIphone ? "iPhone可" : "PC必要") +
              (todo.estimatedMinutes ? " / 約" + todo.estimatedMinutes + "分" : ""),
          ),
        );
        list.appendChild(li);
      });
    } else {
      banner.classList.add("banner-hidden");
    }
  }

  // ---------------------------------------------------------------- todos
  function renderTodos(data) {
    var container = clear(document.getElementById("todo-list"));
    var todos = data.todos || [];
    if (todos.length === 0) {
      container.appendChild(el("p", "muted", "TODO はありません。"));
      return;
    }
    todos.forEach(function (todo) {
      var card = el("div", "todo-item" + (todo.priority === "urgent" ? " urgent" : "") + (todo.status !== "open" ? " done" : ""));
      card.appendChild(el("h3", null, (todo.status === "open" ? "" : "[" + todo.status + "] ") + todo.title));

      var meta = el("div", "todo-meta");
      meta.appendChild(el("span", null, "分類: " + todo.category));
      meta.appendChild(el("span", null, todo.priority === "urgent" ? "緊急" : "通常"));
      meta.appendChild(el("span", null, todo.canUseIphone ? "iPhone で可能" : "PC が必要"));
      if (todo.estimatedMinutes) meta.appendChild(el("span", null, "約 " + todo.estimatedMinutes + " 分"));
      if (todo.waitingTaskIds && todo.waitingTaskIds.length) {
        meta.appendChild(el("span", null, "待機中タスク " + todo.waitingTaskIds.length + " 件"));
      }
      card.appendChild(meta);

      card.appendChild(el("p", null, "理由: " + todo.reason));
      if (todo.steps && todo.steps.length) {
        var ol = el("ol", "todo-steps");
        todo.steps.forEach(function (s) { ol.appendChild(el("li", null, s)); });
        card.appendChild(el("p", "muted", "操作手順:"));
        card.appendChild(ol);
      } else if (todo.actionRequired) {
        card.appendChild(el("p", null, "必要な操作: " + todo.actionRequired));
      }
      card.appendChild(el("p", null, "完了条件: " + todo.completionCondition));
      if (todo.targetUrl) card.appendChild(el("p", "muted", "対象: " + todo.targetUrl));

      if (todo.status === "open") {
        var answer = null;
        if (todo.answerRequired || todo.answerFormat === "text" || todo.answerFormat === "choice") {
          var label = el("label", null, "回答" + (todo.answerRequired ? "（必須）" : "（任意）"));
          card.appendChild(label);
          if (todo.answerFormat === "choice" && todo.answerChoices && todo.answerChoices.length) {
            answer = el("select");
            answer.appendChild(el("option", null, ""));
            todo.answerChoices.forEach(function (c) { answer.appendChild(el("option", null, c)); });
          } else {
            answer = el("textarea");
            answer.rows = 3;
          }
          card.appendChild(answer);
        }
        var msg = el("p", "err");
        var row = el("div", "row");
        var done = el("button", null, "完了にする");
        done.addEventListener("click", function () {
          msg.className = "muted";
          msg.textContent = "送信中…";
          api("/api/todos/" + encodeURIComponent(todo.id) + "/complete", {
            method: "POST",
            body: { answer: answer ? answer.value : null },
          })
            .then(function (result) {
              msg.className = "ok";
              msg.textContent =
                "完了しました。" +
                (result.resumedTaskIds && result.resumedTaskIds.length
                  ? "再開したタスク: " + result.resumedTaskIds.join(", ")
                  : "再開したタスクはありません。");
              refresh();
            })
            .catch(function (err) {
              msg.className = "err";
              msg.textContent = "完了できません: " + err.message;
            });
        });
        var cancel = el("button", "secondary", "この TODO を取り消す");
        cancel.addEventListener("click", function () {
          if (!window.confirm("この TODO を取り消します。よろしいですか？")) return;
          api("/api/todos/" + encodeURIComponent(todo.id) + "/cancel", { method: "POST", body: {} })
            .then(refresh)
            .catch(function (err) { msg.textContent = err.message; });
        });
        row.appendChild(done);
        row.appendChild(cancel);
        card.appendChild(row);
        card.appendChild(msg);
      } else {
        card.appendChild(el("p", "muted", "完了日時: " + fmt(todo.completedAt)));
      }
      container.appendChild(card);
    });
  }

  // ---------------------------------------------------------------- tasks
  function renderTasks(data) {
    var tbody = clear(document.querySelector("#task-table tbody"));
    (data.tasks || []).forEach(function (task) {
      var tr = el("tr");
      tr.appendChild(el("td", null, task.stateLabel + "（" + task.state + "）"));
      tr.appendChild(el("td", null, task.title));
      tr.appendChild(el("td", null, task.source));
      tr.appendChild(el("td", null, task.priority));
      tr.appendChild(el("td", null, task.attempts + " / " + task.maxAttempts));
      tr.appendChild(el("td", null, task.revisionCount + " / " + task.maxRevisions));
      tr.appendChild(el("td", null, fmt(task.updatedAt)));

      var ops = el("td");
      var detail = el("button", "secondary", "詳細");
      detail.addEventListener("click", function () { openTaskDetail(task.id); });
      ops.appendChild(detail);
      if (task.state === "failed" || task.state === "cancelled") {
        var retry = el("button", null, "再試行");
        retry.addEventListener("click", function () {
          api("/api/tasks/" + encodeURIComponent(task.id) + "/retry", { method: "POST", body: {} }).then(refresh);
        });
        ops.appendChild(retry);
      }
      if (["queued", "paused", "awaiting_user", "retry_wait", "revision_required"].indexOf(task.state) >= 0) {
        var cancel = el("button", "danger", "取消");
        cancel.addEventListener("click", function () {
          if (!window.confirm("このタスクを取り消します。よろしいですか？")) return;
          api("/api/tasks/" + encodeURIComponent(task.id) + "/cancel", {
            method: "POST",
            body: { reason: "ダッシュボードからの取消" },
          }).then(refresh);
        });
        ops.appendChild(cancel);
      }
      tr.appendChild(ops);
      tbody.appendChild(tr);
    });
  }

  function openTaskDetail(taskId) {
    api("/api/tasks/" + encodeURIComponent(taskId)).then(function (data) {
      var box = clear(document.getElementById("task-detail"));
      box.classList.remove("hidden");
      box.appendChild(el("h3", null, data.task.title));
      box.appendChild(el("p", "muted", "ID: " + data.task.id + " / 状態: " + data.task.stateLabel));
      if (data.task.blockedReason) box.appendChild(el("p", "err", "保留理由: " + data.task.blockedReason));
      if (data.task.lastError) box.appendChild(el("p", "err", "直近のエラー: " + data.task.lastError));

      function section(title, content) {
        var det = el("details");
        det.appendChild(el("summary", null, title));
        var pre = el("pre", "pre", typeof content === "string" ? content : JSON.stringify(content, null, 2));
        det.appendChild(pre);
        box.appendChild(det);
      }
      section("元の指示", data.instruction || "");
      section("完了報告", data.report || "（まだありません）");
      section("審査履歴", data.reviews || []);
      section("状態履歴", (data.history || []).map(function (h) {
        return fmt(h.at) + "  " + (h.from_state || "-") + " -> " + h.to_state + "  [" + h.actor + "] " + (h.reason || "");
      }).join("\n"));
      section("変更ファイル", (data.task.changedFiles || []).join("\n") || "（なし）");
      box.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // ------------------------------------------------------------ documents
  function renderDocuments(data) {
    var container = clear(document.getElementById("document-list"));
    var docs = data.documents || [];
    if (docs.length === 0) {
      container.appendChild(el("p", "muted", "取り込まれた文書はまだありません。"));
      return;
    }
    docs.forEach(function (doc) {
      var card = el("div", "card");
      card.appendChild(el("h3", null, doc.originalName));
      var meta = el("div", "todo-meta");
      meta.appendChild(el("span", null, "状態: " + doc.parseState));
      meta.appendChild(el("span", null, "受信: " + fmt(doc.receivedAt)));
      meta.appendChild(el("span", null, doc.byteSize + " bytes"));
      meta.appendChild(el("span", null, "表 " + doc.tableCount + " / 画像 " + doc.imageCount));
      if (doc.supersedes) meta.appendChild(el("span", null, "旧版あり"));
      card.appendChild(meta);
      if (doc.errorMessage) card.appendChild(el("p", "err", doc.errorMessage));
      if (doc.hasImages) {
        card.appendChild(el("p", "muted", "画像内の文字は読み取っていません。重要な指示が画像だけに書かれていないかご確認ください。"));
      }

      var row = el("div", "row");
      var preview = el("button", "secondary", "抽出結果を見る");
      preview.addEventListener("click", function () {
        api("/api/documents/" + encodeURIComponent(doc.id)).then(function (d) {
          var det = el("details");
          det.setAttribute("open", "open");
          det.appendChild(el("summary", null, "抽出テキスト"));
          det.appendChild(el("pre", "pre", d.text || "(空)"));
          card.appendChild(det);
        });
      });
      row.appendChild(preview);

      if (doc.parseState === "extracted") {
        var convert = el("button", null, "開発タスクとしてキューに登録");
        convert.addEventListener("click", function () {
          api("/api/documents/" + encodeURIComponent(doc.id) + "/convert", { method: "POST", body: {} })
            .then(function (r) {
              window.alert(r.created ? "タスクを登録しました: " + r.task.title : "同じ内容のタスクが既にあります。");
              refresh();
            })
            .catch(function (err) { window.alert("登録できません: " + err.message); });
        });
        row.appendChild(convert);
      }
      if (doc.taskIds && doc.taskIds.length) {
        row.appendChild(el("span", "muted", "生成済みタスク: " + doc.taskIds.join(", ")));
      }
      card.appendChild(row);
      container.appendChild(card);
    });
  }

  // ------------------------------------------------------------- refresh
  function refresh() {
    if (state.view === "home") {
      api("/api/home").then(renderHome).catch(function () {});
    } else if (state.view === "todos") {
      api("/api/todos").then(renderTodos).catch(function () {});
    } else if (state.view === "tasks") {
      api("/api/tasks").then(renderTasks).catch(function () {});
    } else if (state.view === "documents") {
      api("/api/documents").then(renderDocuments).catch(function () {});
    } else if (state.view === "system") {
      api("/api/system")
        .then(function (r) { document.getElementById("system-report").textContent = JSON.stringify(r, null, 2); })
        .catch(function () {});
    } else if (state.view === "settings") {
      api("/api/settings")
        .then(function (r) { document.getElementById("settings-report").textContent = JSON.stringify(r, null, 2); })
        .catch(function () {});
    } else if (state.view === "audit") {
      api("/api/audit")
        .then(function (data) {
          var tbody = clear(document.querySelector("#audit-table tbody"));
          (data.entries || []).forEach(function (e) {
            var tr = el("tr");
            tr.appendChild(el("td", null, fmt(e.at)));
            tr.appendChild(el("td", null, e.actor));
            tr.appendChild(el("td", null, e.action));
            tr.appendChild(el("td", null, e.target || ""));
            tr.appendChild(el("td", null, (e.result || "") + (e.detail ? " / " + e.detail : "")));
            tbody.appendChild(tr);
          });
        })
        .catch(function () {});
    }
  }

  // --------------------------------------------------------------- wiring
  document.getElementById("tabs").addEventListener("click", function (ev) {
    var button = ev.target.closest(".tab");
    if (button) show(button.dataset.view);
  });
  document.querySelectorAll("[data-view-link]").forEach(function (b) {
    b.addEventListener("click", function () { show(b.dataset.viewLink); });
  });

  document.getElementById("btn-pause").addEventListener("click", function () {
    api("/api/control/pause", { method: "POST", body: {} }).then(refresh);
  });
  document.getElementById("btn-resume").addEventListener("click", function () {
    api("/api/control/resume", { method: "POST", body: {} }).then(refresh);
  });
  document.getElementById("btn-stop-current").addEventListener("click", function () {
    if (!window.confirm("実行中のタスクを安全に停止します。よろしいですか？")) return;
    api("/api/control/stop-current", { method: "POST", body: {} }).then(refresh);
  });
  document.getElementById("btn-diagnose").addEventListener("click", function () {
    api("/api/control/diagnose", { method: "POST", body: {} }).then(function (r) {
      document.getElementById("system-report").textContent = JSON.stringify(r, null, 2);
    });
  });

  document.getElementById("new-task-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var title = document.getElementById("nt-title").value.trim();
    var instruction = document.getElementById("nt-instruction").value.trim();
    var priority = parseInt(document.getElementById("nt-priority").value, 10);
    if (!title || !instruction) return;
    api("/api/tasks", { method: "POST", body: { title: title, instruction: instruction, priority: priority } })
      .then(function (r) {
        window.alert(r.created ? "登録しました。" : "同じ内容のタスクが既にあります（二重登録は行いません）。");
        document.getElementById("new-task-form").reset();
        document.getElementById("nt-priority").value = "50";
        refresh();
      })
      .catch(function (err) { window.alert("登録できません: " + err.message); });
  });

  document.getElementById("btn-upload").addEventListener("click", function () {
    var input = document.getElementById("doc-file");
    var status = document.getElementById("upload-status");
    if (!input.files || input.files.length === 0) {
      status.className = "err";
      status.textContent = "ファイルを選んでください。";
      return;
    }
    var file = input.files[0];
    status.className = "muted";
    status.textContent = "アップロード中…";
    file.arrayBuffer().then(function (buf) {
      api("/api/documents/upload?filename=" + encodeURIComponent(file.name), { method: "POST", raw: buf })
        .then(function () {
          status.className = "ok";
          status.textContent = "取り込みました。";
          input.value = "";
          refresh();
        })
        .catch(function (err) {
          status.className = "err";
          status.textContent = "取り込めません: " + err.message;
        });
    });
  });

  show("home");
  setInterval(function () { refresh(); }, 10000);
})();
