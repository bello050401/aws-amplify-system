import { mkdir, rm, writeFile } from "fs/promises";
import path from "path";
import type { StorageProvider, UploadedObject } from "./StorageProvider";

/**
 * 開発環境向けのローカルディスク実装。
 * `UPLOAD_DIR` 配下に保存し、Route Handler (`/uploads/[...path]`) 経由、または
 * `PUBLIC_UPLOAD_BASE_URL` を通じて外部公開する。
 */
export class LocalStorageProvider implements StorageProvider {
  private readonly baseDir: string;
  private readonly publicBaseUrl: string;

  constructor() {
    this.baseDir = process.env.UPLOAD_DIR ?? "./uploads";
    this.publicBaseUrl =
      process.env.PUBLIC_UPLOAD_BASE_URL ?? "http://localhost:3000/uploads";
  }

  async put(params: { key: string; data: Buffer; contentType: string }): Promise<UploadedObject> {
    const fullPath = path.join(this.baseDir, params.key);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, params.data);
    return {
      storageKey: params.key,
      publicUrl: `${this.publicBaseUrl.replace(/\/$/, "")}/${params.key}`,
    };
  }

  async remove(key: string): Promise<void> {
    const fullPath = path.join(this.baseDir, key);
    await rm(fullPath, { force: true });
  }
}
