"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "aws-amplify/auth";
import { ConfigureAmplifyClientSide } from "@/lib/amplify/configureClient";

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn({ username: email, password });
      router.push("/admin");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ログインに失敗しました。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone px-6">
      <ConfigureAmplifyClientSide />
      <form onSubmit={handleSubmit} className="w-full max-w-sm bg-white p-10 shadow-sm">
        <h1 className="text-lg font-normal text-ink">管理画面ログイン</h1>
        <div className="mt-8 space-y-4">
          <div>
            <label className="block text-xs uppercase tracking-label text-muted">メールアドレス</label>
            <input
              type="email"
              required
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
    </div>
  );
}
