"use client";

import { useEffect } from "react";

/**
 * 第六ラウンド P0-1: /inventory以下(保護route含む — layout.tsxの認証
 * チェックや、一覧/詳細/EC出品ページの各種データ取得)で予期しない
 * 例外が発生した場合の安全なフォールバック。Server Action(app/actions/
 * *.ts)の業務エラーはもう`{ok:false,error}`という戻り値で伝わる設計
 * (app/actions/ai.tsのコメント参照)になったため、ここに到達するのは
 * 「本当に予期しない」例外(AWS SDKの内部エラー、想定外のnull参照等)
 * だけのはず——それでもアプリ全体をNext.jsの既定フォールバック画面
 * (production buildで実機確認した通り、意味の無い一般的な文言だけを
 * 表示する)に晒さないための、業務ドメインに合わせた安全な着地点。
 */
export default function InventoryError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // クライアント側でも一言記録しておく(実際の完全なstackはNext.js自身が
    // サーバー側stderrへ既に出力済み——ここでは開発者コンソールでの
    // 追跡補助のみ、secretは一切含まれない)。
    console.error("[InventoryError boundary]", { digest: error.digest, message: error.message });
  }, [error]);

  return (
    <div className="flex h-full min-h-[50vh] items-center justify-center px-6">
      <div className="max-w-md text-center">
        <p className="text-sm font-bold text-gray-900">画面の表示中に問題が発生しました</p>
        <p className="mt-2 text-xs text-gray-600">
          お手数ですが、再試行するか一覧画面へ戻ってください。問題が続く場合は、下記の参照番号を添えてサポートへご連絡ください。
        </p>
        {error.digest && <p className="mt-3 text-[11px] text-gray-400">参照番号: {error.digest}</p>}
        <div className="mt-4 flex justify-center gap-2">
          <button type="button" onClick={() => reset()} className="border border-gray-900 px-4 py-1.5 text-xs font-bold text-gray-900 hover:bg-gray-50">
            再試行
          </button>
          <a href="/inventory" className="border border-gray-300 px-4 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
            在庫一覧へ戻る
          </a>
        </div>
      </div>
    </div>
  );
}
