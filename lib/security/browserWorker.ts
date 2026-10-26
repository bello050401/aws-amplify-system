/// <reference lib="webworker" />
import { protectedBusinessPath } from "./routes";
import { requestProofMessage } from "./requestProof";
import {isTerminalSessionError,SESSION_INVALID_MESSAGE} from './sessionInvalidation';
declare const self: ServiceWorkerGlobalScope;
const b64 = (buffer: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function settings() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("bello-approved-browser-v1", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("settings");
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  try { return await new Promise<{ key: CryptoKeyPair; binding: string }>((resolve, reject) => {
    const tx = db.transaction("settings"), store = tx.objectStore("settings"), key = store.get("keyPair"), binding = store.get("requestBinding");
    tx.oncomplete = () => resolve({ key: key.result, binding: binding.result }); tx.onerror = () => reject(tx.error);
  }); } finally { db.close(); }
}
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !protectedBusinessPath(url.pathname)) return;
  event.respondWith((async () => {
    const { key, binding } = await settings();
    if (!key?.privateKey || !binding) return fetch(event.request);
    const data = await event.request.clone().arrayBuffer();
    if (data.byteLength > 32 * 1024 * 1024) return new Response(JSON.stringify({ error: "REQUEST_TOO_LARGE" }), { status: 413, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    const proof = { version: 1 as const, at: Math.floor(Date.now() / 1000), nonce: b64(crypto.getRandomValues(new Uint8Array(32))),
      binding, digest: b64(await crypto.subtle.digest("SHA-256", data)) };
    const message = requestProofMessage(url.origin, event.request.method, url.pathname + url.search, proof);
    const signature = b64(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(message)));
    const headers = new Headers(event.request.headers); headers.set("x-bello-device-proof", JSON.stringify({ ...proof, signature }));
    // No CacheStorage, JWT, cached inventory, or fallback to an unsigned success.
    const response=await fetch(new Request(event.request, { headers, cache: "no-store" }));
    if((response.status===401||response.status===403)&&response.headers.get('content-type')?.includes('application/json')){
      const failure=await response.clone().json().catch(()=>null);
      if(isTerminalSessionError(failure?.error))for(const client of await self.clients.matchAll({type:'window'}))client.postMessage({type:SESSION_INVALID_MESSAGE});
    }
    return response;
  })().catch(() => new Response(JSON.stringify({ error: "DEVICE_PROOF_UNAVAILABLE" }), { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } })));
});
