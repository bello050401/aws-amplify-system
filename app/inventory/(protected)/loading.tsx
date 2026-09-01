/**
 * 画面遷移の即時フィードバック（指示書§16）。
 *
 * このルートグループにはloading.tsxが1つも無かった。App Routerでは
 * loading.tsxが無いと、サーバー側の描画が終わるまでブラウザは前の画面を
 * 表示したままになる —— 利用者から見ると「押したのに何も起きない」。
 * 実測でも、一覧のTTFBが約8秒の間ずっと前の画面のままだった。
 *
 * ここで出すのは骨格だけ。中身が来るまでの間、遷移が始まったことと
 * 画面のかたちが分かればよい。スピナー1つで誤魔化さず、実際の
 * レイアウトに近い形にしておくと、内容が入れ替わるときのがたつきも減る。
 */
export default function InventoryLoading() {
  return (
    <div className="flex h-full flex-col" aria-busy="true" aria-live="polite">
      <div className="flex h-[var(--inventory-header-height)] shrink-0 items-center gap-3 border-b border-gray-200 px-4">
        <div className="h-4 w-32 animate-pulse rounded bg-gray-200" />
        <div className="h-6 w-64 animate-pulse rounded bg-gray-100" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="hidden w-56 shrink-0 border-r border-gray-200 p-3 md:block">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="mb-2 h-4 w-full animate-pulse rounded bg-gray-100" />
          ))}
        </div>
        <div className="min-w-0 flex-1 p-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="mb-1.5 h-8 w-full animate-pulse rounded bg-gray-100" />
          ))}
        </div>
      </div>
      <span className="sr-only">読み込み中</span>
    </div>
  );
}
