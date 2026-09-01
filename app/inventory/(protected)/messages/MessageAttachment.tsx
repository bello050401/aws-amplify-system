"use client";

import { useEffect, useState } from "react";
import { getMessageAttachmentUrlAction } from "@/app/actions/messaging";

/**
 * 受信メッセージに添付された画像を表示する。
 *
 * S3のキーをそのまま <img src> にはできない(バケットは非公開)ので、
 * 署名付きURLをサーバー側で作って受け取る。URLには期限があるため、
 * 保存するのはキーの方で、URLは表示のたびに作り直す。
 */
export function MessageAttachment({ storageKey, contentType }: { storageKey: string; contentType: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
  }, [storageKey]);

  if (error) return <p className="mt-1 text-[11px] text-amber-700">画像を表示できませんでした: {error}</p>;
  if (!url) return <p className="mt-1 text-[11px] text-gray-400">画像を読み込んでいます…</p>;

  // 画像以外(PDF等)はリンクにする。中身を勝手に埋め込まない。
  if (contentType && !contentType.startsWith("image/")) {
    return (
      <a href={url} target="_blank" rel="noreferrer noopener" className="mt-1 block text-[12px] text-blue-700 underline">
        添付ファイルを開く
      </a>
    );
  }

  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className="mt-1 block">
      {/* next/image を使わないのは、署名付きURL(毎回変わる・外部ホスト)が
          画像最適化の対象にならないため。実サイズはS3側の原本に依存するので、
          表示幅で抑える。 */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="受信画像" className="max-h-64 max-w-full rounded border border-gray-200" loading="lazy" />
    </a>
  );
}
