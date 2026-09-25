"use client";

import { useEffect, useRef, useState } from "react";
import { getPhotoBatchCoverAction } from "@/app/actions/photoRegistration";

export function PhotoBatchCover({ batchId }: { batchId: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const target = root.current;
    if (!target) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return;
      observer.disconnect();
      void getPhotoBatchCoverAction(batchId).then((result) => {
        if (result.ok) setUrl(result.value);
      }).catch(() => setUrl(null)).finally(() => setLoaded(true));
    }, { rootMargin: "200px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [batchId]);
  return <div ref={root} className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded bg-gray-100 text-xs text-gray-400">
    {url ? <img src={url} alt="バッチの代表写真" className="h-full w-full object-contain" onError={() => setUrl(null)} /> : loaded ? "画像なし" : "読込中"}
  </div>;
}
