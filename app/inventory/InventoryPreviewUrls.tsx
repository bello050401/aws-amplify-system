"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Hub } from "aws-amplify/utils";
import { useInventoryImageUrl } from "./useInventoryImageUrl";

const PreviewUrls = createContext<Record<string, string>>({});

/** URLs are scoped to the authorized record rendered by the server, never persisted. */
export function InventoryPreviewUrls({ urls, children }: { urls: Record<string, string>; children: ReactNode }) {
  const [invalidated, setInvalidated] = useState(false);
  useEffect(() => Hub.listen("auth", ({ payload }) => {
    if (payload.event === "signedOut" || payload.event === "signedIn") setInvalidated(true);
  }), []);
  return <PreviewUrls.Provider value={invalidated ? {} : urls}>{children}</PreviewUrls.Provider>;
}

/** Expired server URLs fall back once to the existing authenticated resolver. */
export function useInventoryPreviewUrl(key: string | null) {
  const urls = useContext(PreviewUrls);
  const direct = key ? urls[key] : undefined;
  const [rejected, setRejected] = useState<string | null>(null);
  const useDirect = Boolean(direct && direct !== rejected);
  const resolved = useInventoryImageUrl(useDirect ? null : key);
  const rejectDirect = useCallback(() => {
    if (!useDirect || !direct) return false;
    setRejected(direct);
    return true;
  }, [direct, useDirect]);
  return { ...resolved, url: useDirect ? direct! : resolved.url, rejectDirect };
}
