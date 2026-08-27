export interface UploadedObject {
  storageKey: string;
  publicUrl: string;
}

/**
 * 画像保存先を抽象化するインターフェース。
 * Phase 1はローカルディスク実装のみ使用するが、本番ではCloudflare R2 / Amazon S3へ
 * 差し替え可能な構造にする（指示書3, 11, 12項）。実装は必ず外部公開可能なURLを返すこと。
 */
export interface StorageProvider {
  /** ファイルを保存し、公開URLを返す。 */
  put(params: { key: string; data: Buffer; contentType: string }): Promise<UploadedObject>;
  /** ファイルを削除する。存在しなくてもエラーにしない。 */
  remove(key: string): Promise<void>;
}
