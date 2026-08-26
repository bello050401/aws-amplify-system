import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";

/**
 * ローカルストレージ開発用の画像配信エンドポイント。
 * 本番ではCloudflare R2 / S3の公開URLを直接使うためこのルートは経由しない
 * （STORAGE_PROVIDER=local のときのみ使用、指示書3, 12項）。
 */
const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await params;
  // パストラバーサル対策
  if (segments.some((s) => s.includes("..") || s.includes("\0"))) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }
  // 本番ではSTORAGE_PROVIDER=s3/r2を使うため、このdevルートの動的パス解決は
  // ビルドトレース対象から除外する(turbopackIgnore)。
  const baseDir = path.resolve(/* turbopackIgnore: true */ process.env.UPLOAD_DIR ?? "./uploads");
  const filePath = path.resolve(baseDir, ...segments);
  if (!filePath.startsWith(baseDir)) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_BY_EXT[ext] ?? "application/octet-stream";
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
