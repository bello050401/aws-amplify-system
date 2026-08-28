// BELLO在庫管理システム Service Worker
//
// 完全オフライン在庫管理は要件外(指示書 §3)のため、対応範囲は最小限:
//  - PWAシェル(静的アセット)をキャッシュしてホーム画面起動を高速化
//  - ナビゲーション(ページ遷移)がオフラインで失敗した場合に offline.html を表示
//  - 在庫データ自体はキャッシュしない(常に最新のAPI応答を利用する)
const CACHE_NAME = "bello-shell-v1";
const SHELL_ASSETS = [
  "/offline.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // ページ遷移(HTML)はネット優先、失敗時はoffline.htmlへフォールバック
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/offline.html"))
    );
    return;
  }

  // 静的アセットはキャッシュ優先
  if (SHELL_ASSETS.some((a) => request.url.endsWith(a))) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request))
    );
  }
});
