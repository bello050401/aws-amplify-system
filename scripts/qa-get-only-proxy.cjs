// 手動repro: Codex CUAの「GET専用proxy」を模した最小限の合成proxy。
// 3114で待ち受け、GET/HEADはそのまま3100へforward、それ以外の
// メソッド(POST等、Server Actionが使う)は405で拒否する。ヘッダ/
// cookieは素通し(改変しない)——「GETのみ許可」という制約だけを
// 切り出して直接cookieの扱いとは独立に検証するため。
// 本番には一切含まれない、この検証セッション専用の使い捨てスクリプト。
const http = require("http");

const TARGET_HOST = "127.0.0.1";
const TARGET_PORT = 3100;
// 3114は既に別プロセス(このサンドボックス上の無関係なnext devらしき
// 別サーバー、"/"→"/admin"へredirectする別アプリ)が使用中だったため、
// 他作業を止めない方針(指示書§6)により3115を使う。ポート番号自体は
// 「GETのみ許可」という制約の検証には無関係。
const LISTEN_PORT = 3115;

const server = http.createServer((req, res) => {
  console.log(`[proxy] ${req.method} ${req.url}`);
  if (req.method !== "GET" && req.method !== "HEAD") {
    console.log(`[proxy] BLOCKED non-GET method: ${req.method} ${req.url}`);
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed (GET-only proxy)");
    req.resume();
    return;
  }

  const proxyReq = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      method: req.method,
      path: req.url,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (err) => {
    console.error("[proxy] upstream error:", err.message);
    if (!res.headersSent) res.writeHead(502);
    res.end("Bad Gateway");
  });
  req.pipe(proxyReq);
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(`[proxy] GET-only proxy listening on http://127.0.0.1:${LISTEN_PORT} -> http://${TARGET_HOST}:${TARGET_PORT}`);
});
