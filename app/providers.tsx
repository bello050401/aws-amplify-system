"use client";

import { useEffect } from "react";
import { AuthProvider } from "@/lib/auth/AuthProvider";

/**
 * アプリ全体のクライアント側プロバイダ。
 * Service Workerの登録(PWA)と認証コンテキストをここで初期化する。
 */
export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (typeof window !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Service Worker登録失敗は致命的ではないため握りつぶす(PWAは必須要件だが
        // 完全オフライン対応は必須要件ではない §3)
      });
    }
  }, []);

  return <AuthProvider>{children}</AuthProvider>;
}
