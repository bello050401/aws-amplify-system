"use client";

import { useState, type MouseEvent } from "react";
import Link from "next/link";

export const SPEED_PROBE_SESSION_KEY = "bello.inventory-speed-probe.v1";

function clock(): number | null {
  const timer = window.performance;
  return timer && Number.isFinite(timer.timeOrigin) && typeof timer.now === "function"
    ? timer.timeOrigin + timer.now()
    : null;
}

/** Starts timing in the browser immediately before the normal list-to-detail Link navigation. */
export function InventorySpeedProbeLink({ href, endAt }: { href: string; endAt: string }) {
  const [error, setError] = useState(false);

  function begin(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      event.preventDefault();
      return;
    }
    if (!Number.isFinite(Date.parse(endAt)) || Date.now() >= Date.parse(endAt)) {
      event.preventDefault();
      setError(true);
      return;
    }
    try {
      sessionStorage.setItem(SPEED_PROBE_SESSION_KEY, JSON.stringify({
        startedWallMs: Date.now(), startedClockMs: clock(),
      }));
    } catch {
      event.preventDefault();
      setError(true);
    }
  }

  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-950">
      <span className="mr-3">検証環境限定：B005778の一覧→詳細と画像表示をブラウザー内で計測</span>
      <Link href={href} onClick={begin} className="font-bold underline">計測を開始して詳細を開く</Link>
      {error && <span className="ml-3">計測期限切れ、またはこのブラウザーでは計測を開始できません。</span>}
    </div>
  );
}
