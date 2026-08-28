"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { isAmplifyBackendConfigured, ensureAmplifyConfigured } from "@/lib/amplify/config";
import type { CurrentUser } from "@/lib/types";

/**
 * 認証コンテキスト。PC版・モバイル版は同一のCognito User Poolセッションを共有する
 * (指示書 §25)。モバイルだけ認証をバイパスしない。
 *
 * amplify_outputs.json 未デプロイ時は、ローカル動作確認用のモック認証
 * (localStorageにセッションを保持)にフォールバックする。実AWSデプロイ後は
 * 自動的にCognitoによる本物のログイン/セッション維持/ログアウト/権限判定に切り替わる。
 */
interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  isBackendConfigured: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const MOCK_SESSION_KEY = "bello-mock-session-v1";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      if (isAmplifyBackendConfigured) {
        ensureAmplifyConfigured();
        try {
          const { getCurrentUser, fetchAuthSession } = await import("aws-amplify/auth");
          const current = await getCurrentUser();
          const session = await fetchAuthSession();
          const groups = (session.tokens?.accessToken.payload["cognito:groups"] as string[]) ?? [];
          setUser({
            userId: current.userId,
            email: current.signInDetails?.loginId ?? current.username,
            groups,
          });
        } catch {
          setUser(null);
        }
      } else if (typeof window !== "undefined") {
        const raw = window.localStorage.getItem(MOCK_SESSION_KEY);
        if (raw) setUser(JSON.parse(raw));
      }
      setLoading(false);
    })();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    if (isAmplifyBackendConfigured) {
      const { signIn: amplifySignIn, getCurrentUser, fetchAuthSession } = await import("aws-amplify/auth");
      await amplifySignIn({ username: email, password });
      const current = await getCurrentUser();
      const session = await fetchAuthSession();
      const groups = (session.tokens?.accessToken.payload["cognito:groups"] as string[]) ?? [];
      setUser({ userId: current.userId, email, groups });
    } else {
      if (!email || !password) throw new Error("メールアドレスとパスワードを入力してください");
      // デモ用モック認証: "admin" を含むメールアドレスはAdminsグループ扱い
      const groups = email.toLowerCase().includes("admin") ? ["Admins", "Staff"] : ["Staff"];
      const mockUser: CurrentUser = { userId: `mock_${email}`, email, groups, displayName: email.split("@")[0] };
      window.localStorage.setItem(MOCK_SESSION_KEY, JSON.stringify(mockUser));
      setUser(mockUser);
    }
  }, []);

  const signOut = useCallback(async () => {
    if (isAmplifyBackendConfigured) {
      const { signOut: amplifySignOut } = await import("aws-amplify/auth");
      await amplifySignOut();
    } else {
      window.localStorage.removeItem(MOCK_SESSION_KEY);
    }
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      isBackendConfigured: isAmplifyBackendConfigured,
      signIn,
      signOut,
      isAdmin: user?.groups.includes("Admins") ?? false,
    }),
    [user, loading, signIn, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
