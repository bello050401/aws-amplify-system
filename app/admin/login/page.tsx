"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { confirmSignIn, signIn } from "aws-amplify/auth";
import { ConfigureAmplifyClientSide } from "@/lib/amplify/configureClient";

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  // Cognito users created via `admin-create-user` without --temporary-password
  // start in FORCE_CHANGE_PASSWORD state — the first sign-in succeeds but
  // returns a "choose a new password" challenge instead of a session. This
  // is the normal, expected first-login path for an admin account, not an
  // error case, so it gets its own step in this form rather than a retry.
  const [needsNewPassword, setNeedsNewPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { nextStep } = await signIn({ username: email, password });
      if (nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") {
        setNeedsNewPassword(true);
        return;
      }
      router.push("/admin");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ログインに失敗しました。");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleNewPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await confirmSignIn({ challengeResponse: newPassword });
      router.push("/admin");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "パスワードの設定に失敗しました。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone px-6">
      <ConfigureAmplifyClientSide />
      {needsNewPassword ? (
        <form onSubmit={handleNewPassword} className="w-full max-w-sm bg-white p-10 shadow-sm">
          <h1 className="text-lg font-normal text-ink">新しいパスワードを設定</h1>
          <p className="mt-2 text-xs text-muted">
            初回ログインのため、新しいパスワードを設定してください。
          </p>
          <div className="mt-6">
            <label className="block text-xs uppercase tracking-label text-muted">新しいパスワード</label>
            <input
              type="password"
              required
              minLength={8}
              autoFocus
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="mt-1 w-full border border-line px-3 py-2 text-sm focus:border-ink focus:outline-none"
            />
          </div>
          {error && <p className="mt-4 text-xs text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="mt-8 w-full bg-ink py-3 text-xs uppercase tracking-label text-white disabled:opacity-50"
          >
            {submitting ? "設定中…" : "設定してログイン"}
          </button>
        </form>
      ) : (
        <form onSubmit={handleSignIn} className="w-full max-w-sm bg-white p-10 shadow-sm">
          <h1 className="text-lg font-normal text-ink">管理画面ログイン</h1>
          <div className="mt-8 space-y-4">
            <div>
              <label className="block text-xs uppercase tracking-label text-muted">メールアドレス</label>
              <input
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full border border-line px-3 py-2 text-sm focus:border-ink focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-label text-muted">パスワード</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full border border-line px-3 py-2 text-sm focus:border-ink focus:outline-none"
              />
            </div>
          </div>
          {error && <p className="mt-4 text-xs text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="mt-8 w-full bg-ink py-3 text-xs uppercase tracking-label text-white disabled:opacity-50"
          >
            {submitting ? "ログイン中…" : "ログイン"}
          </button>
        </form>
      )}
    </div>
  );
}
