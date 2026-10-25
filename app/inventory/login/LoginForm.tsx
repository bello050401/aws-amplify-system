"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { confirmSignIn, fetchAuthSession, signIn, signOut } from "aws-amplify/auth";
import { ConfigureAmplifyClientSide } from "@/lib/amplify/configureClient";
import { BelloLogo } from "../BelloLogo";

const NOT_AUTHORIZED_MESSAGE =
  "このアカウントはログインできますが、在庫システムの権限（ADMIN / EDITOR / VIEWER）がありません。管理者に権限グループへの追加を依頼してください。";

const INVENTORY_GROUPS = ["ADMIN", "EDITOR", "VIEWER"];

type ClientSessionStatus = "authorized" | "signed-in-not-authorized" | "signed-out";

async function getClientSessionStatus(): Promise<ClientSessionStatus> {
  const session = await fetchAuthSession();
  if (!session.tokens) return "signed-out";
  const groups = (session.tokens.accessToken.payload["cognito:groups"] ?? []) as string[];
  return groups.some((g) => INVENTORY_GROUPS.includes(g)) ? "authorized" : "signed-in-not-authorized";
}

interface InventoryLoginPageProps {
  searchParams: { error?: string };
}

/**
 * Deliberately its own screen, separate from /admin/login — Inventory
 * checks membership in ADMIN/EDITOR/VIEWER, not "Admins" (see
 * amplify/auth/resource.ts), and per spec §31 doesn't need to look like
 * the Feature-page generator's lookbook-styled login. A person in both
 * worlds' groups just signs in once here or there; Cognito sessions
 * aren't scoped per app route.
 */
export default function InventoryLoginPage({ searchParams }: InventoryLoginPageProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [needsNewPassword, setNeedsNewPassword] = useState(false);
  const [error, setError] = useState<string | null>(
    searchParams.error === "not_authorized" ? NOT_AUTHORIZED_MESSAGE : null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  /** 別のアプリ側で有効なセッションを持っている状態。勝手に切らず、案内だけ出す。 */
  const [signedInElsewhere, setSignedInElsewhere] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const status = await getClientSessionStatus();
      if (cancelled) return;

      if (status === "authorized") {
        router.replace("/inventory");
        return;
      }
      if (status === "signed-in-not-authorized") {
        // ここで signOut() を呼んではいけない。
        //
        // このアプリは在庫管理(/inventory)と管理画面(/admin)の2つを載せて
        // おり、Cognitoのセッションは両者で共有されている。以前はここで
        // 無条件にサインアウトしていたため、**片方に正常ログインしている
        // 利用者が、もう片方のログイン画面を開いただけでセッションを失う**
        // 状態だった。ルート(/)は/adminへ転送されるので、在庫管理を使って
        // いる人がドメインを直打ち・ブックマークから開くだけで踏む
        // (実際にこの監査中、refresh tokenが revoked になって作業中の
        //  セッションが切れた)。
        //
        // 権限が無いことを伝えるだけにして、いま使える画面への導線を出す。
        // 別アカウントで入り直したい場合だけ、明示的にボタンを押して
        // サインアウトしてもらう。
        setError(NOT_AUTHORIZED_MESSAGE);
        setSignedInElsewhere(true);
      }
      if (!cancelled) setCheckingSession(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  function afterSignedIn(nextStep: { signInStep: string }) {
    if (nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") {
      setNeedsNewPassword(true);
      return;
    }
    router.push("/inventory");
    router.refresh();
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { nextStep } = await signIn({ username: email, password });
      afterSignedIn(nextStep);
    } catch (err) {
      if (err instanceof Error && err.name === "UserAlreadyAuthenticatedException") {
        try {
          await signOut();
          const { nextStep } = await signIn({ username: email, password });
          afterSignedIn(nextStep);
          return;
        } catch (retryErr) {
          setError(retryErr instanceof Error ? retryErr.message : "ログインに失敗しました。");
          return;
        }
      }
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
      router.push("/inventory");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "パスワードの設定に失敗しました。");
    } finally {
      setSubmitting(false);
    }
  }

  if (checkingSession) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-6">
        <ConfigureAmplifyClientSide />
        <p className="text-xs text-gray-500">確認中…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-6">
      <ConfigureAmplifyClientSide />
      {needsNewPassword ? (
        <form onSubmit={handleNewPassword} className="w-full max-w-sm border border-gray-300 bg-white p-8">
          <div className="flex justify-center">
            <BelloLogo variant="login" />
          </div>
          <p className="mt-4 text-center text-xs text-gray-500">初回ログインのため、新しいパスワードを設定してください。</p>
          <div className="mt-6">
            <label className="block text-xs font-medium text-gray-600">新しいパスワード</label>
            <input
              type="password"
              required
              minLength={8}
              autoFocus
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="mt-1 w-full border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
            />
          </div>
          {error && <p className="mt-4 text-xs text-red-600">{error}</p>}
          {signedInElsewhere && (
            /* 別アプリ側の有効なセッションを保ったまま案内する。
               「別のアカウントでログイン」を押したときだけサインアウトする。 */
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
              <a href="/admin" className="font-bold underline">
                管理画面へ戻る
              </a>
              <button
                type="button"
                onClick={async () => {
                  await signOut();
                  setSignedInElsewhere(false);
                  setError(null);
                }}
                className="text-gray-500 underline hover:text-gray-900"
              >
                別のアカウントでログインする
              </button>
            </div>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="mt-6 w-full bg-gray-900 py-2 text-sm text-white disabled:opacity-50"
          >
            {submitting ? "設定中…" : "設定してログイン"}
          </button>
        </form>
      ) : (
        <form onSubmit={handleSignIn} className="w-full max-w-sm border border-gray-300 bg-white p-8">
          <div className="flex justify-center">
            <BelloLogo variant="login" />
          </div>
          <div className="mt-6 space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600">メールアドレス</label>
              <input
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">パスワード</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
              />
            </div>
          </div>
          {error && <p className="mt-4 text-xs text-red-600">{error}</p>}
          {signedInElsewhere && (
            /* 別アプリ側の有効なセッションを保ったまま案内する。
               「別のアカウントでログイン」を押したときだけサインアウトする。 */
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
              <a href="/admin" className="font-bold underline">
                管理画面へ戻る
              </a>
              <button
                type="button"
                onClick={async () => {
                  await signOut();
                  setSignedInElsewhere(false);
                  setError(null);
                }}
                className="text-gray-500 underline hover:text-gray-900"
              >
                別のアカウントでログインする
              </button>
            </div>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="mt-6 w-full bg-gray-900 py-2 text-sm text-white disabled:opacity-50"
          >
            {submitting ? "ログイン中…" : "ログイン"}
          </button>
        </form>
      )}
    </div>
  );
}
