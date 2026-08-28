"use client";

import { useEffect, useRef, useState } from "react";

/**
 * QR/バーコードスキャナ(指示書 §10, §21, §29)。
 * 編集画面の「コードを撮影して登録」・ホームの「スキャン検索」・入庫・出庫すべてで
 * この1つのコンポーネント/スキャンロジックを再利用する(同じスキャンロジックを
 * 複数実装しない)。
 *
 * @zxing/browser を使用し、QR・JAN/EAN等の主要バーコード形式を読み取る。
 * カメラ権限の許可はiPhone実機でのユーザー本人操作が必要(指示書 §32)。
 */
export function BarcodeScanner({
  onDetected,
  onClose,
}: {
  onDetected: (code: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const detectedRef = useRef(false);

  useEffect(() => {
    let controls: { stop: () => void } | null = null;
    let cancelled = false;

    (async () => {
      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const reader = new BrowserMultiFormatReader();
        if (!videoRef.current || cancelled) return;
        controls = await reader.decodeFromVideoDevice(
          undefined,
          videoRef.current,
          (result, err) => {
            if (result && !detectedRef.current) {
              detectedRef.current = true;
              const text = result.getText();
              if (navigator.vibrate) navigator.vibrate(50);
              onDetected(text);
            }
          }
        );
      } catch (e) {
        setError(
          e instanceof Error
            ? `カメラを起動できませんでした: ${e.message}`
            : "カメラを起動できませんでした。設定でカメラへのアクセスを許可してください。"
        );
      }
    })();

    return () => {
      cancelled = true;
      controls?.stop();
    };
  }, [onDetected]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="safe-top flex items-center justify-between px-4 py-3">
        <span className="text-sm font-medium text-white">QR / バーコードを読み取る</span>
        <button onClick={onClose} className="tap-target rounded-full bg-white/20 px-3 py-1 text-sm text-white">
          閉じる
        </button>
      </div>

      <div className="relative flex-1">
        <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-56 w-56 rounded-2xl border-4 border-white/80 shadow-[0_0_0_2000px_rgba(0,0,0,0.35)]" />
        </div>
        {error && (
          <div className="absolute inset-x-4 top-1/2 -translate-y-1/2 rounded-2xl bg-white p-4 text-center text-sm text-danger-600">
            {error}
          </div>
        )}
      </div>
      <p className="pb-safe-nav bg-black py-3 text-center text-xs text-white/70">
        コードを枠内に合わせてください
      </p>
    </div>
  );
}
