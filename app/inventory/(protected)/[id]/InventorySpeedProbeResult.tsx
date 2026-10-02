"use client";

import { useEffect, useState } from "react";
import { SPEED_PROBE_SESSION_KEY } from "../InventorySpeedProbeLink";

type Result = {
  status: "complete" | "timeout" | "expired";
  detailDomMs: number;
  imageReadyMs: number;
  loadedImages: number;
  expectedImages: number;
  clock: "monotonic" | "wall";
};

type Start = { startedWallMs: number; startedClockMs: number | null };

function currentClock(): number | null {
  const timer = window.performance;
  return timer && Number.isFinite(timer.timeOrigin) && typeof timer.now === "function"
    ? timer.timeOrigin + timer.now()
    : null;
}

function onScreen(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left);
  let top = Math.max(0, rect.top);
  let right = Math.min(window.innerWidth, rect.right);
  let bottom = Math.min(window.innerHeight, rect.bottom);
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
      const boundary = parent.getBoundingClientRect();
      left = Math.max(left, boundary.left);
      top = Math.max(top, boundary.top);
      right = Math.min(right, boundary.right);
      bottom = Math.min(bottom, boundary.bottom);
    }
  }
  return right > left && bottom > top;
}

function requiredImageSlots(): HTMLElement[] | null {
  const primary = document.querySelector<HTMLElement>('[data-inventory-speed-gallery="primary"]');
  if (!primary) return null;
  const galleries = document.querySelectorAll<HTMLElement>("[data-inventory-speed-gallery]");
  const slots: HTMLElement[] = [];
  for (const gallery of galleries) {
    const hero = gallery.querySelector<HTMLElement>("[data-inventory-speed-hero]");
    if (!hero) return null;
    // The primary hero is required; other images count only if initially visible.
    if (gallery === primary || onScreen(hero)) slots.push(hero);
    for (const thumb of gallery.querySelectorAll<HTMLElement>("[data-inventory-speed-thumb]")) {
      if (onScreen(thumb)) slots.push(thumb);
    }
  }
  return slots;
}

function loadedCount(slots: HTMLElement[]): number {
  return slots.filter(slot => {
    const img = slot.querySelector<HTMLImageElement>("img");
    return Boolean(img && img.complete && img.naturalWidth > 0 && getComputedStyle(img).visibility !== "hidden");
  }).length;
}

/** Browser-local result only. No URLs, product data, image bytes, or timing events are sent out. */
export function InventorySpeedProbeResult({ endAt }: { endAt: string }) {
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    let start: Start;
    try {
      const raw = sessionStorage.getItem(SPEED_PROBE_SESSION_KEY);
      if (!raw) return;
      sessionStorage.removeItem(SPEED_PROBE_SESSION_KEY);
      start = JSON.parse(raw) as Start;
    } catch { return; }
    const endMs = Date.parse(endAt);
    if (!Number.isFinite(start.startedWallMs) || Date.now() - start.startedWallMs > 120_000 ||
        Date.now() < start.startedWallMs || !Number.isFinite(endMs) || Date.now() >= endMs) return;

    const useMonotonic = start.startedClockMs !== null && Number.isFinite(start.startedClockMs) && currentClock() !== null;
    const elapsed = () => Math.max(0, Math.round((useMonotonic ? currentClock()! - start.startedClockMs! : Date.now() - start.startedWallMs)));
    const detailDomMs = elapsed();
    const deadline = Date.now() + 20_000;
    let frame = 0;
    let cancelled = false;
    let slots: HTMLElement[] | null = null;
    function check() {
      if (cancelled) return;
      if (Date.now() >= endMs) {
        setResult({ status: "expired", detailDomMs: 0, imageReadyMs: 0, loadedImages: 0,
          expectedImages: 0, clock: useMonotonic ? "monotonic" : "wall" });
        return;
      }
      slots ??= requiredImageSlots();
      const loaded = slots ? loadedCount(slots) : 0;
      if (slots && loaded === slots.length) {
        setResult({ status: "complete", detailDomMs, imageReadyMs: elapsed(), loadedImages: loaded,
          expectedImages: slots.length, clock: useMonotonic ? "monotonic" : "wall" });
      } else if (Date.now() >= deadline) {
        setResult({ status: "timeout", detailDomMs, imageReadyMs: elapsed(), loadedImages: loaded,
          expectedImages: slots?.length ?? 0, clock: useMonotonic ? "monotonic" : "wall" });
      } else {
        frame = requestAnimationFrame(check);
      }
    }
    frame = requestAnimationFrame(check);
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [endAt]);

  if (!result) return null;
  return (
    <div role="status" data-inventory-speed-result className="mt-3 border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
      <p className="font-bold">表示速度検証：{result.status === "complete" ? "画像表示完了" : result.status === "expired" ? "計測期限切れ" : "20秒以内に画像が揃いませんでした"}</p>
      {result.status !== "expired" && <>
        <p>詳細DOM: {result.detailDomMs} ms ／ 主画像と初期表示画像: {result.imageReadyMs} ms ／ 読込済み: {result.loadedImages}/{result.expectedImages}</p>
        <p>計時: ブラウザー内{result.clock === "monotonic" ? "単調時計" : "時計"}。画面外の遅延画像は対象外。画像のキャッシュ状態は不明。保存・送信はしていません。</p>
      </>}
    </div>
  );
}
