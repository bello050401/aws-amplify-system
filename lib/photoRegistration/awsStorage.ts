/**
 * 画像登録基盤 Phase 1 — S3アダプター (実行可能、未デプロイ)。
 *
 * lib/photoRegistration/ports.ts の PhotoStoragePort を実装する。
 *
 * 【presigned PUTの完全性 (§5.5)】
 * `buildPutObjectCommandInput` が ContentType / ContentLength / ChecksumSHA256
 * をコマンドへ固定する。SigV4署名はこれらをリクエストヘッダに含めるため、
 * クライアントが異なる値でPUTすると署名不一致でS3が拒否する — 「クライアント
 * が勝手に別サイズ・別ハッシュへ差し替える」を署名レベルで防ぐ。
 *
 * `getSignedUrl` はネットワークを一切使わず、クライアント設定 (region/
 * credentials) を使ったオフラインの署名計算のみを行う。そのため
 * scripts/verify-photo-registration-api.ts はダミーの静的credentialsを
 * 与えるだけで、実AWSアクセスなしにこの層を検証できる。
 *
 * 【checksumの表現】契約 (types.ts SHA256_PATTERN) はsha256を小文字hex 64桁
 * で扱うが、S3の `ChecksumSHA256` / HeadObjectの `ChecksumSHA256` はbase64。
 * 変換はこのファイルでのみ行い、他層はhexしか知らない。
 */

import { HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObservedS3Object, PhotoAssetVariant } from "./types";
import type { PhotoStoragePort, PresignedUpload } from "./ports";
import type { UploadTarget } from "./state";

export function hexToBase64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

export function base64ToHex(base64: string): string {
  return Buffer.from(base64, "base64").toString("hex");
}

/** presigned PUT発行前に組み立てるcommand入力。ネットワークを使わないため単体試験可能。 */
export function buildPutObjectCommandInput(bucket: string, target: UploadTarget) {
  return {
    Bucket: bucket,
    Key: target.s3Key,
    ContentType: target.expectedMimeType,
    ContentLength: target.expectedBytes,
    ChecksumSHA256: hexToBase64(target.expectedSha256),
  };
}

/** HeadObjectの結果をObservedS3Objectへ写す。宣言値との突合せはstate.ts側の責務であり、ここでは観測値をそのまま運ぶだけ。 */
export function mapHeadObjectOutputToObserved(
  variant: PhotoAssetVariant,
  output: { ContentLength?: number; ContentType?: string; ChecksumSHA256?: string } | null,
): ObservedS3Object {
  if (!output) return { variant, exists: false, contentLength: null, sha256: null, contentType: null };
  return {
    variant,
    exists: true,
    contentLength: output.ContentLength ?? null,
    contentType: output.ContentType ?? null,
    sha256: output.ChecksumSHA256 ? base64ToHex(output.ChecksumSHA256) : null,
  };
}

export interface S3PhotoStorageConfig {
  s3Client: S3Client;
  /** photo-batches/* を置くバケット名。未設定でこのクラスを構築させない (fail closed)。 */
  bucketName: string;
  /** presigned PUTの有効期限 (秒)。Photo Stationの25枚chunkアップロードが余裕を持って終わる長さにする。 */
  uploadUrlExpirySeconds?: number;
}

export class S3PhotoStorage implements PhotoStoragePort {
  private readonly s3Client: S3Client;
  private readonly bucketName: string;
  private readonly uploadUrlExpirySeconds: number;

  constructor(config: S3PhotoStorageConfig) {
    if (!config.bucketName) throw new Error("Photo registration S3 bucket name is not configured (fail closed)");
    this.s3Client = config.s3Client;
    this.bucketName = config.bucketName;
    this.uploadUrlExpirySeconds = config.uploadUrlExpirySeconds ?? 900;
  }

  async presignUploadTargets(targets: UploadTarget[]): Promise<PresignedUpload[]> {
    const results: PresignedUpload[] = [];
    for (const target of targets) {
      const command = new PutObjectCommand(buildPutObjectCommandInput(this.bucketName, target));
      // ChecksumSHA256をqueryへhoistすると、Node fetch/S3の組み合わせでは
      // オブジェクトにSHA-256が保存されず既定CRC64だけになる。headerを
      // 署名対象として残し、Photo Stationが同じ値を送ることでHEAD時に
      // ChecksumSHA256を必ず検証できるようにする。
      const uploadUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn: this.uploadUrlExpirySeconds,
        unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
      });
      results.push({ ...target, uploadUrl });
    }
    return results;
  }

  async headObjects(targets: { variant: PhotoAssetVariant; s3Key: string }[]): Promise<ObservedS3Object[]> {
    const observed: ObservedS3Object[] = [];
    for (const target of targets) {
      try {
        // ChecksumMode: "ENABLED" が無いとS3はChecksumSHA256をHeadObjectの
        // 応答へ含めない (デフォルトでは省略される) — これが無いと常に
        // observed.sha256=null になり、正常アップロードでも
        // UPLOAD_NOT_COMPLETE (checksum取得不能) で弾かれ続ける。
        const output = await this.s3Client.send(
          new HeadObjectCommand({ Bucket: this.bucketName, Key: target.s3Key, ChecksumMode: "ENABLED" }),
        );
        observed.push(mapHeadObjectOutputToObserved(target.variant, output));
      } catch (error) {
        if (isNotFound(error)) {
          observed.push(mapHeadObjectOutputToObserved(target.variant, null));
          continue;
        }
        throw error;
      }
    }
    return observed;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && (error as { name: string }).name === "NotFound";
}
