"use client";

import { useRouter } from "next/navigation";

/**
 * モバイルヘッダー(指示書 §4-1)。左:戻る/中央:タイトル/右:操作。
 */
export function MobileHeader({
  title,
  onBack,
  right,
  hideBack = false,
}: {
  title: string;
  onBack?: () => void;
  right?: React.ReactNode;
  hideBack?: boolean;
}) {
  const router = useRouter();
  return (
    <header className="safe-top sticky top-0 z-30 flex items-center gap-2 border-b border-bello-100 bg-white/95 px-2 py-2 backdrop-blur md:hidden">
      <div className="flex min-w-11 shrink-0 justify-start">
        {!hideBack && (
          <button
            onClick={() => (onBack ? onBack() : router.back())}
            className="tap-target flex items-center justify-center text-xl text-bello-700"
            aria-label="戻る"
          >
            ←
          </button>
        )}
      </div>
      <h1 className="flex-1 truncate text-center text-base font-bold text-bello-900">{title}</h1>
      <div className="flex min-w-11 shrink-0 justify-end whitespace-nowrap">{right}</div>
    </header>
  );
}
