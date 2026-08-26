import type { StorageProvider, UploadedObject } from "./StorageProvider";

/**
 * Cloudflare R2 / Amazon S3 実装のプレースホルダー。
 *
 * 本番切替時は AWS SDK (`@aws-sdk/client-s3`) 等を追加し、S3互換APIで
 * `put`/`remove` を実装すること。設定値は `.env` の S3_* / R2_* を使用する
 * （docs/architecture.md 7節）。Phase 1ではローカルストレージのみを使用するため、
 * このクラスは呼び出されないよう `StorageProviderFactory` でガードしている。
 */
export class RemoteStorageProviderStub implements StorageProvider {
  constructor(private readonly kind: "s3" | "r2") {}

  async put(): Promise<UploadedObject> {
    throw new Error(
      `StorageProvider "${this.kind}" is not implemented yet. Phase 1 only supports STORAGE_PROVIDER=local. See docs/architecture.md.`,
    );
  }

  async remove(): Promise<void> {
    throw new Error(
      `StorageProvider "${this.kind}" is not implemented yet. Phase 1 only supports STORAGE_PROVIDER=local.`,
    );
  }
}
