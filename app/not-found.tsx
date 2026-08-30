import Link from "next/link";

/**
 * 存在しないURLを開いたときの画面。
 *
 * これが無いとNext.jsの既定画面がそのまま出る — 実機で確認したところ
 * 「404 / This page could not be found.」という英語1行だけで、他が
 * すべて日本語のこのアプリの中で明らかに浮いていた。削除済みの商品の
 * URLを開いた場合など、利用者が普通に到達しうる画面なので、
 * app/inventory/error.tsx と同じ文体・同じ構成で用意する。
 *
 * 行き先を1つに決め打ちしない: このリポジトリは在庫管理(/inventory)と
 * 管理画面(/admin)の2つを載せており、どちらの利用者がここへ来るか
 * 分からない。在庫一覧への導線は出しつつ、ブラウザの「戻る」でも
 * 帰れることを明記する。
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-md text-center">
        <p className="text-sm font-bold text-gray-900">お探しのページは見つかりませんでした</p>
        <p className="mt-2 text-xs text-gray-600">
          URLが変わったか、対象のデータが削除された可能性があります。ブラウザの「戻る」で直前の画面に戻れます。
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <Link href="/inventory" className="border border-gray-900 px-4 py-1.5 text-xs font-bold text-gray-900 hover:bg-gray-50">
            在庫一覧へ
          </Link>
        </div>
      </div>
    </div>
  );
}
