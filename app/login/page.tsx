"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth/AuthProvider";
import { toErrorMessage } from "@/components/common/ErrorState";
import { InlineSpinner } from "@/components/common/LoadingOverlay";

/**
 * ログイン画面。PC版・モバイル版共通で、既存(実AWSデプロイ後)のAmazon Cognitoを
 * そのまま利用する(指示書 §25)。実デプロイ前はローカル動作確認用モック認証。
 */
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const { user, loading, signIn, isBackendConfigured } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && user) {
      router.replace(params.get("next") ?? "/");
    }
  }, [loading, user, router, params]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await signIn(email, password);
      router.replace(params.get("next") ?? "/");
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bello-900 px-6 safe-top safe-bottom">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-white">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white text-2xl font-black text-bello-800">
            B
          </div>
          <h1 className="text-lg font-bold">BELLO在庫管理</h1>
          <p className="text-xs text-bello-200">在庫を、どこからでも。</p>
        </div>

        {!isBackendConfigured && (
          <div className="mb-4 rounded-xl bg-accent-500/20 px-4 py-3 text-xs text-accent-100">
            実AWSバックエンド未接続のため、ローカル動作確認モードです。任意のメールアドレス/パスワードでログインできます(
            <code>admin</code> を含むメールでAdmins権限)。
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3 rounded-3xl bg-white p-6 shadow-floating">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-bello-700">メールアドレス</span>
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="tap-target w-full rounded-2xl border border-bello-200 px-4 py-3 text-base outline-none focus:border-bello-500"
              placeholder="you@example.com"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-bello-700">パスワード</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="tap-target w-full rounded-2xl border border-bello-200 px-4 py-3 text-base outline-none focus:border-bello-500"
              placeholder="••••••••"
            />
          </label>
          {error && <p className="text-sm text-danger-600">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="tap-target flex w-full items-center justify-center gap-2 rounded-full bg-bello-800 py-3 text-sm font-bold text-white active:bg-bello-900 disabled:opacity-60"
          >
            {submitting && <InlineSpinner />}
            ログイン
          </button>
        </form>
      </div>
    </div>
  );
}
