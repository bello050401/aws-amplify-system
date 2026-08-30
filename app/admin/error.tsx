"use client";

/**
 * 第六ラウンド P0-1: app/inventory/error.tsxと同じ理由・同じ安全設計を
 * /admin以下にも適用する(このアプリ全体でerror.tsxが1つも存在しな
 * かったことが根本原因の一部だったため——特定の1画面だけでなく、
 * 同種のルートには揃って適用する)。
 */
export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center px-6">
      <div className="max-w-md text-center">
        <p className="text-sm font-bold text-gray-900">画面の表示中に問題が発生しました</p>
        <p className="mt-2 text-xs text-gray-600">お手数ですが、再試行してください。問題が続く場合は、下記の参照番号を添えてサポートへご連絡ください。</p>
        {error.digest && <p className="mt-3 text-[11px] text-gray-400">参照番号: {error.digest}</p>}
        <button type="button" onClick={() => reset()} className="mt-4 border border-gray-900 px-4 py-1.5 text-xs font-bold text-gray-900 hover:bg-gray-50">
          再試行
        </button>
      </div>
    </div>
  );
}
