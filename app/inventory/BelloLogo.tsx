"use client";

import { useState } from "react";

export type BelloLogoVariant = "sidebar" | "login";

/**
 * Per-spot sizing, defined once here rather than each screen hardcoding
 * its own `<img>` tag/className — a screen picks a `variant`, it doesn't
 * write layout classes itself. Height-only (no fixed width): the icon's
 * own design already carries the "BELLO SYSTEM" wordmark, at whatever
 * its real aspect ratio is, so forcing a square (or any fixed width)
 * would either crop it or leave dead space — `w-auto` + `object-contain`
 * lets the image's intrinsic ratio decide its width, capped by
 * `max-w-*` only so an unusually wide source file can't blow out the
 * (narrow, w-16) sidebar rail.
 *
 * - "sidebar": InventoryNavRail's brand area — this IS the brand mark up
 *   there now (spec: no more separate "BELLO" text beside a small icon);
 *   72px tall (~1.5x the original 48px, per follow-up request) — the
 *   nav rail itself (`w-16`, 64px) is never widened for this: InventoryNavRail
 *   clips its brand container with `overflow-hidden`, so even if the
 *   real file's aspect ratio would otherwise render wider than the rail,
 *   it's cropped there rather than pushing the rail wider or shifting
 *   the nav items below it.
 * - "login": next to the "BELLO 在庫管理" heading on the login screen —
 *   unchanged by that follow-up request.
 */
const VARIANT_CLASSES: Record<BelloLogoVariant, string> = {
  sidebar: "h-[72px] w-auto max-w-[84px]",
  login: "h-10 w-auto max-w-[160px]",
};

/**
 * BELLO SYSTEM's icon — used sparingly, in a few natural brand spots
 * (nav rail header, login screen) per spec's "業務システムとして自然
 * なブランド表示" guidance, not scattered across every screen.
 *
 * Renders nothing (not a broken-image icon) if /bello-system-icon.png
 * hasn't actually been placed in public/ yet — this component itself
 * never fails to render just because that one file is missing; see this
 * repo's Phase completion reports for the single file-placement step
 * needed.
 */
export function BelloLogo({ variant = "sidebar", className }: { variant?: BelloLogoVariant; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a small static public/ asset, not something next/image's optimizer adds value to
    <img
      src="/bello-system-icon.png"
      alt="BELLO SYSTEM"
      className={`${className ?? VARIANT_CLASSES[variant]} shrink-0 object-contain`}
      onError={() => setFailed(true)}
    />
  );
}
