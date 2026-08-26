"use client";

import { useRef, useState } from "react";

export interface ProductImageRow {
  id: string;
  publicUrl: string;
  sortOrder: number;
  isPrimary: boolean;
}

export function ImageUploader({
  productId,
  initialImages,
}: {
  productId: string;
  initialImages: ProductImageRow[];
}) {
  const [images, setImages] = useState<ProductImageRow[]>(initialImages);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dragIndex = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    try {
      const form = new FormData();
      for (const f of list) form.append("files", f);
      const res = await fetch(`/api/products/${productId}/images`, {
        method: "POST",
        body: form,
      });
      const json = await res.json();
      if (!res.ok) {
        alert(json.error ?? "画像のアップロードに失敗しました。");
        return;
      }
      setImages(json.images);
    } finally {
      setUploading(false);
    }
  }

  async function persistOrder(next: ProductImageRow[]) {
    setImages(next);
    const res = await fetch(`/api/products/${productId}/images`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedImageIds: next.map((i) => i.id) }),
    });
    const json = await res.json();
    if (res.ok) setImages(json.images);
  }

  async function removeImage(id: string) {
    if (!confirm("この画像を削除しますか？")) return;
    const res = await fetch(`/api/products/${productId}/images/${id}`, { method: "DELETE" });
    if (res.ok) {
      setImages((prev) => prev.filter((i) => i.id !== id));
    }
  }

  function handleDropReorder(targetIndex: number) {
    if (dragIndex.current === null || dragIndex.current === targetIndex) return;
    const next = [...images];
    const [moved] = next.splice(dragIndex.current, 1);
    next.splice(targetIndex, 0, moved);
    dragIndex.current = null;
    void persistOrder(next);
  }

  return (
    <div className="space-y-3">
      <div
        className={`flex flex-col items-center justify-center rounded-md border-2 border-dashed p-6 text-sm ${
          dragOver ? "border-indigo-400 bg-indigo-50" : "border-slate-300 text-slate-500"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void uploadFiles(e.dataTransfer.files);
        }}
      >
        <p>画像をドラッグ&ドロップ、またはタップして選択（複数選択可）</p>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && uploadFiles(e.target.files)}
        />
        <button
          type="button"
          className="btn-secondary mt-2"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? "アップロード中…" : "ファイルを選択"}
        </button>
      </div>

      {images.length > 0 && (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
          {images.map((img, index) => (
            <div
              key={img.id}
              draggable
              onDragStart={() => (dragIndex.current = index)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => handleDropReorder(index)}
              className="group relative aspect-square cursor-move overflow-hidden rounded-md border border-slate-200"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.publicUrl} alt="" className="h-full w-full object-cover" />
              {img.isPrimary && (
                <span className="absolute left-1 top-1 rounded bg-indigo-600 px-1.5 py-0.5 text-[10px] text-white">
                  メイン
                </span>
              )}
              <button
                type="button"
                className="absolute right-1 top-1 hidden rounded bg-white/90 px-1.5 py-0.5 text-[10px] text-red-600 group-hover:block"
                onClick={() => removeImage(img.id)}
              >
                削除
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-slate-400">
        画像をドラッグして並び替えられます。並び順の先頭がメルカリShopsのメイン画像になります。
      </p>
    </div>
  );
}
