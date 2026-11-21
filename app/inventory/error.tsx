"use client";

import { useEffect, useState } from "react";
import { reportSystemError, safeErrorClass, safeErrorDigest } from '@/lib/systemErrors/client';

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
  const [reported, setReported] = useState(false);
  useEffect(() => {
    // クライアント側でも一言記録しておく(実際の完全なstackはNext.js自身が
    // サーバー側stderrへ既に出力済み——ここでは開発者コンソールでの
    // 追跡補助のみ、secretは一切含まれない)。
    let active = true;
    setReported(false);
    console.error("[InventoryError boundary]", { digest: safeErrorDigest(error), errorClass: safeErrorClass(error) });
    void reportSystemError({ code: 'UI_RENDER_FAILED', surface: 'web', component: 'inventory', operation: 'render', errorClass: safeErrorClass(error), digest: safeErrorDigest(error) }).then(ok => { if (active) setReported(ok); });
    return () => { active = false; };
  }, [error]);

  return (
    <div className="flex h-full min-h-[50vh] items-center justify-center px-6">
      <div className="max-w-md text-center">
        <p className="text-sm font-bold text-gray-900">画面の表示中に問題が発生しました</p>
        <p className="mt-2 text-xs text-gray-600">
          お手数ですが、再試行するか一覧画面へ戻ってください。問題が続く場合は、下記の参照番号を添えてサポートへご連絡ください。
        </p>
        {error.digest && <p className="mt-3 text-[11px] text-gray-400">参照番号: {error.digest}</p>}
        {reported && <p role="status" className="mt-3 text-xs text-gray-600">エラーを修復受付へ送信しました。</p>}
        <div className="mt-4 flex justify-center gap-2">
          <button type="button" onClick={() => reset()} className="border border-gray-900 px-4 py-1.5 text-xs font-bold text-gray-900 hover:bg-gray-50">
            再試行
          </button>
          {/* Full navigation discards the prior authentication/error router state. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/inventory" className="border border-gray-300 px-4 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
            在庫一覧へ戻る
          </a>
        </div>
      </div>
    </div>
  );
}
