"use client";

import { useState } from "react";

/**
 * BELLO SYSTEM's icon — used sparingly, in a few natural brand spots
 * (nav rail header, login screen), per spec's "業務システムとして自然
 * なブランド表示" guidance, not scattered across every screen.
 *
 * Renders nothing (not a broken-image icon) if /bello-system-icon.png
 * hasn't actually been placed in public/ yet — this component itself
 * never fails to render just because that one file is missing; see this
 * Phase's completion report for the single file-placement step needed.
 */
export function BelloLogo({ className = "h-6 w-6" }: { className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a small static public/ asset, not something next/image's optimizer adds value to
    <img src="/bello-system-icon.png" alt="BELLO SYSTEM" className={`${className} shrink-0 object-contain`} onError={() => setFailed(true)} />
  );
}
