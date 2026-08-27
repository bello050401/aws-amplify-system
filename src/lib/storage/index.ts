import type { StorageProvider } from "./StorageProvider";
import { LocalStorageProvider } from "./LocalStorageProvider";
import { RemoteStorageProviderStub } from "./RemoteStorageProviderStub";

export type { StorageProvider, UploadedObject } from "./StorageProvider";

let cached: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  if (cached) return cached;
  const kind = (process.env.STORAGE_PROVIDER ?? "local").toLowerCase();
  switch (kind) {
    case "local":
      cached = new LocalStorageProvider();
      break;
    case "s3":
    case "r2":
      cached = new RemoteStorageProviderStub(kind);
      break;
    default:
      throw new Error(`Unknown STORAGE_PROVIDER: ${kind}`);
  }
  return cached;
}
