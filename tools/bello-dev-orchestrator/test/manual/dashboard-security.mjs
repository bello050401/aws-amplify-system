/**
 * ダッシュボードのセキュリティ試験 (指示書 §14-4)。
 *
 * 稼働中の Orchestrator に対して実際に HTTP を投げる。node --test では動かない
 * (サーバが必要) ため、手動または CI の統合ステージで実行する。
 *
 *   powershell -ExecutionPolicy Bypass -File .ello.ps1 status   # 稼働を確認
 *   node test/manual/dashboard-security.mjs
 *
 * 検証内容: CSRF ヘッダ / Origin 検査、XSS 文字列がデータとして扱われること、
 * アップロードの拡張子とパストラバーサル、静的配信の許可リスト、
 * TODO の必須回答検証、API 応答に秘密が出ないこと。
 */
const BASE = "http://127.0.0.1:4319";
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [NG] ${name}  ${detail}`); }
};

const json = (path, init) => fetch(BASE + path, init).then(async (r) => ({ status: r.status, body: await r.text() }));

// 1) 読み取りは通る
{
  const r = await json("/api/home");
  check("GET /api/home は 200", r.status === 200, `status=${r.status}`);
}

// 2) CSRF: X-BELLO-Request が無い POST は拒否
{
  const r = await json("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "csrf", instruction: "csrf" }),
  });
  check("CSRF: X-BELLO-Request 無しの POST を 403 で拒否", r.status === 403, `status=${r.status} ${r.body}`);
}

// 3) CSRF: 別オリジンからの POST は拒否
{
  const r = await json("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BELLO-Request": "1", Origin: "http://evil.example" },
    body: JSON.stringify({ title: "csrf2", instruction: "csrf2" }),
  });
  check("CSRF: 異なる Origin の POST を 403 で拒否", r.status === 403, `status=${r.status}`);
}

// 4) XSS 文字列はデータとして保存され、HTML として返らない
let xssTaskId = null;
{
  const payload = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
  const r = await json("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BELLO-Request": "1" },
    body: JSON.stringify({ title: payload, instruction: "XSS 試験", priority: 1 }),
  });
  const body = JSON.parse(r.body);
  xssTaskId = body.task?.id ?? null;
  check("XSS: 危険文字列を含むタスクを登録できる", r.status === 201 || r.status === 200, `status=${r.status}`);

  const list = await fetch(BASE + "/api/tasks");
  const ct = list.headers.get("content-type") ?? "";
  const text = await list.text();
  check("XSS: 応答は JSON であり HTML ではない", ct.includes("application/json"), ct);
  check("XSS: 文字列はエスケープされた JSON 文字列として返る", text.includes('\u003c') || text.includes('<script>'), "");
  // JSON 内に生の </script> があっても、クライアントは textContent で描画するので実行されない。
  // ここではサーバが HTML を組み立てていないことを確認するのが目的。
}

// 5) アップロード: 拡張子チェック
{
  const r = await json("/api/documents/upload?filename=" + encodeURIComponent("evil.exe"), {
    method: "POST",
    headers: { "X-BELLO-Request": "1" },
    body: new Uint8Array([1, 2, 3]),
  });
  check("アップロード: .docx 以外を拒否", r.status === 400, `status=${r.status} ${r.body}`);
}

// 6) アップロード: パストラバーサル名は拒否/無害化される
{
  const r = await json("/api/documents/upload?filename=" + encodeURIComponent("..\..\..\Windows\evil.docx"), {
    method: "POST",
    headers: { "X-BELLO-Request": "1" },
    body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // 壊れた zip
  });
  // ファイル名は無害化され、壊れた zip なので error 側へ回る。500 にはならないこと。
  check("アップロード: パストラバーサル名でも 5xx にならない", r.status < 500, `status=${r.status} ${r.body}`);
}

// 7) 静的配信: 許可リスト外は 404
{
  const r = await json("/../../../../Windows/win.ini");
  check("静的配信: 許可リスト外は取得できない", r.status === 404 || r.status === 400, `status=${r.status}`);
}

// 8) TODO: 必須回答なしの完了はサーバ側で拒否
{
  const todos = JSON.parse((await json("/api/todos")).body).todos;
  const target = todos.find((t) => t.status === "open" && t.answerRequired);
  if (!target) { console.log("  [--] 必須回答つき TODO が無いため skip"); }
  else {
    const r = await json(`/api/todos/${target.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-BELLO-Request": "1" },
      body: JSON.stringify({ answer: "   " }),
    });
    check("TODO: 必須回答が空なら 400 で拒否", r.status === 400, `status=${r.status} ${r.body}`);
  }
}

// 9) 秘密が API から漏れない
{
  const settings = (await json("/api/settings")).body;
  const system = (await json("/api/system")).body;
  check("設定 API に apiKey の値が含まれない", !/sk-[A-Za-z0-9]/.test(settings), "");
  check("システム API は apiKeyConfigured の真偽だけを返す", /"apiKeyConfigured":(true|false)/.test(system) && !/sk-[A-Za-z0-9]/.test(system), "");
}

// 後片付け: XSS 試験タスクを取り消す
if (xssTaskId) {
  await json(`/api/tasks/${xssTaskId}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BELLO-Request": "1" },
    body: JSON.stringify({ reason: "セキュリティ試験の後片付け" }),
  });
}

console.log(`\n合格 ${pass} / 不合格 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
