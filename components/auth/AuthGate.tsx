"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth/AuthProvider";
import { LoadingOverlay } from "@/components/common/LoadingOverlay";

const PUBLIC_PATHS = ["/login"];

/**
 * 認証ガード。PC版・モバイル版共通で、未ログイン時は/loginへ誘導する
 * (指示書 §25: モバイルだけ認証をバイパスしない)。
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const isPublic = PUBLIC_PATHS.includes(pathname);

  useEffect(() => {
    if (!loading && !user && !isPublic) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [loading, user, isPublic, pathname, router]);

  if (isPublic) return <>{children}</>;
  if (loading) return <LoadingOverlay label="ログイン状態を確認しています..." />;
  if (!user) return <LoadingOverlay label="ログイン画面へ移動しています..." />;
  return <>{children}</>;
}
