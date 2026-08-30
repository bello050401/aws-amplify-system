"use client";

/**
 * 第六ラウンド P0-1 (§27回帰Gate/§28セキュリティ): このアプリには
 * これまでerror.tsx/global-error.tsxが1つも存在しなかった(`find app
 * -iname "error.tsx"`で実測確認済み、推測ではない)——そのため、
 * ルートlayout自体を含むどこかでキャッチされない例外が発生すると、
 * Next.jsの既定フォールバック("Application error: a server-side
 * exception has occurred..."、production buildで実機再現し確認済み)
 * がそのまま表示されていた。
 *
 * これは「エラーをtry/catchで隠す」対応ではない——App Routerの正規の
 * エラーバウンダリ機構であり、Next.js公式が推奨する唯一の方法。実際の
 * 例外はNext.js自身がサーバーログへ完全なstack付きで出力し続ける
 * (このコンポーネントはdigestだけを安全に表示する——secretやstackを
 * 画面に出さない)。
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="ja">
      <body className="flex min-h-screen items-center justify-center bg-white px-6 text-gray-900">
        <div className="max-w-md text-center">
          <p className="text-sm font-bold text-gray-900">予期しないエラーが発生しました</p>
          <p className="mt-2 text-xs text-gray-600">
            お手数ですが、時間をおいて再試行してください。問題が続く場合は、下記の参照番号を添えてサポートへご連絡ください。
          </p>
          {error.digest && <p className="mt-3 text-[11px] text-gray-400">参照番号: {error.digest}</p>}
          <button
            type="button"
            onClick={() => reset()}
            className="mt-4 border border-gray-900 px-4 py-1.5 text-xs font-bold text-gray-900 hover:bg-gray-50"
          >
            再試行
          </button>
        </div>
      </body>
    </html>
  );
}
