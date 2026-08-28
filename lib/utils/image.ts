/**
 * 画像アップロード前のクライアント側処理 (指示書 §9-3)。
 *
 * - 圧縮: 長辺を最大1600pxにリサイズしJPEG品質0.82で再エンコード
 * - EXIF orientation: createImageBitmap({ imageOrientation: "from-image" })
 *   によりブラウザ側で自動的に正しい向きに補正して描画する
 * - HEIC対応: iOS Safariは `<input type="file">` 経由で選択されたHEIC画像を
 *   アップロード時に自動でJPEGへ変換して渡す挙動があるため、多くの場合追加変換は
 *   不要。念のためcreateImageBitmapが失敗した場合はそのまま元ファイルを使う
 *   フォールバックを用意する。
 */

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.82;

export async function compressImageForUpload(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY)
    );
    if (!blob) return file;

    const newName = file.name.replace(/\.(heic|heif|png|webp)$/i, ".jpg");
    return new File([blob], newName, { type: "image/jpeg" });
  } catch {
    // createImageBitmapが使えない/失敗した場合は元ファイルのままアップロードする
    return file;
  }
}

export function isSupportedImageFile(file: File): boolean {
  return (
    file.type.startsWith("image/") ||
    /\.(heic|heif)$/i.test(file.name) // 一部端末はHEICのmime typeが空になることがある
  );
}

export const MAX_IMAGES_PER_ITEM = 10;
