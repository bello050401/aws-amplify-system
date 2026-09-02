"use client";

import { useEffect, useRef, useState } from "react";
import { getMessageAttachmentUrlAction } from "@/app/actions/messaging";

/**
 * 受信メッセージに添付された画像を表示する。
 *
 * S3のキーをそのまま <img src> にはできない(バケットは非公開)ので、
 * 署名付きURLをサーバー側で作って受け取る。URLには期限があるため、
 * 保存するのはキーの方で、URLは表示のたびに作り直す。
 *
 * ── 2026-09-02 指示書§17: 画像は本当に見える直前まで取りに行かない ──
 *
 * 以前はこのコンポーネントがマウントした時点で署名付きURLを作っていた。
 * つまり**会話を開いた瞬間に、その会話の画像すべてぶんの署名付きURLが
 * 生成される**。画像が何十枚も溜まった会話では、その全部が無駄な往復に
 * なる(ほとんどは画面外にある)。
 *
 * IntersectionObserver で「表示領域に入りかけたら」初めて要求する。
 * rootMargin を 200px 取っているのは、スクロールして見えた瞬間に
 * 「読み込んでいます…」が出るのを避けるため —— 少し手前で取り始める。
 *
 * IntersectionObserver が使えない環境ではその場で取得へフォールバック
 * する(機能が落ちるより、少し余分に取るほうがまし)。
 */
export function MessageAttachment({ storageKey, contentType }: { storageKey: string; contentType: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const holderRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = holderRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    getMessageAttachmentUrlAction(storageKey)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setUrl(result.url);
        else setError(result.error);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "画像を表示できませんでした。");
      });
    return () => {
      cancelled = true;
    };
  }, [storageKey, visible]);

  // 画像単体の失敗で会話全体を落とさない(指示書§33)。再試行できるようにする。
  if (error) {
    return (
      <div ref={holderRef} className="mt-1 border border-amber-300 bg-amber-50 p-1 text-[11px] text-amber-800">
        <p>画像を表示できませんでした: {error}</p>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setUrl(null);
            setVisible(true);
          }}
          className="mt-1 border border-amber-400 px-2 py-0.5"
        >
          再読み込み
        </button>
      </div>
    );
  }

  if (!url) {
    // 高さを確保しておく。取得後に行が飛び跳ねないようにするため。
    return (
      <div ref={holderRef} className="mt-1 h-16 text-[11px] text-gray-400">
        {visible ? "画像を読み込んでいます…" : "画像（スクロールすると読み込みます）"}
      </div>
    );
  }

  // 画像以外(PDF等)はリンクにする。中身を勝手に埋め込まない。
  if (contentType && !contentType.startsWith("image/")) {
    return (
      <div ref={holderRef}>
        <a href={url} target="_blank" rel="noreferrer noopener" className="mt-1 block text-[12px] text-blue-700 underline">
          添付ファイルを開く
        </a>
      </div>
    );
  }

  return (
    <div ref={holderRef}>
      <a href={url} target="_blank" rel="noreferrer noopener" className="mt-1 block">
        {/* next/image を使わないのは、署名付きURL(毎回変わる・外部ホスト)が
            画像最適化の対象にならないため。実サイズはS3側の原本に依存するので、
            表示幅で抑える。 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="受信画像" className="max-h-64 max-w-full rounded border border-gray-200" loading="lazy" />
      </a>
    </div>
  );
}
