const http = require("node:http");

const TOKEN = "e2e-local-test-token-not-a-real-secret-32c";

const req = http.request(
  {
    host: "127.0.0.1",
    port: 3100,
    path: "/inventory/e2e-inv-7",
    method: "GET",
    headers: { Cookie: `__inv_e2e_role=ADMIN:${TOKEN}` },
  },
  (res) => {
    const t0 = Date.now();
    let firstByteAt = null;
    let total = 0;
    let sawLoadingSkeleton = false;
    let sawFallback = false;
    let sawStatusId = false;
    const chunkLog = [];
    res.on("data", (chunk) => {
      if (firstByteAt === null) firstByteAt = Date.now();
      total += chunk.length;
      const s = chunk.toString("utf8");
      if (s.includes("animate-pulse")) sawLoadingSkeleton = true;
      if (s.includes("読み込み中")) sawFallback = true;
      if (s.includes("statusId")) sawStatusId = true;
      chunkLog.push({ t: Date.now() - t0, len: chunk.length, hasStatusId: s.includes("statusId"), hasFallback: s.includes("読み込み中"), hasSkeleton: s.includes("animate-pulse") });
    });
    res.on("end", () => {
      console.log("status", res.statusCode);
      console.log("TTFB(ms)", firstByteAt - t0);
      console.log("total time(ms)", Date.now() - t0);
      console.log("total bytes", total);
      console.log("chunks", chunkLog.length, JSON.stringify(chunkLog));
      console.log("sawLoadingSkeleton(route loading.tsx)", sawLoadingSkeleton);
      console.log("sawFallback(読み込み中 substring anywhere)", sawFallback);
      console.log("sawStatusId(resolved history in same response)", sawStatusId);
    });
  },
);
req.on("error", (e) => {
  console.error("request error", e);
  process.exit(1);
});
req.end();
