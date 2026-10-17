import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";

/** Cognito tokens never enter the inventory cache or ordinary device storage. */
export class SecureTokenStorage {
  private serial: Promise<unknown> = Promise.resolve();
  private indexKey = "bello.auth.key-index.v1";
  private key(key: string) { return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, key).then(hash => `bello.auth.${hash}`); }
  async getItem(key: string): Promise<string | null> { await this.serial; return SecureStore.getItemAsync(await this.key(key)); }
  async setItem(key: string, value: string): Promise<void> {
    const next = this.serial.then(async () => {
      const target = await this.key(key);
      const keys = JSON.parse(await SecureStore.getItemAsync(this.indexKey) ?? "[]") as string[];
      if (!keys.includes(target)) await SecureStore.setItemAsync(this.indexKey, JSON.stringify([...keys, target]));
      await SecureStore.setItemAsync(target, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    });
    this.serial = next.catch(() => {}); await next;
  }
  async removeItem(key: string): Promise<void> { await this.serial; await SecureStore.deleteItemAsync(await this.key(key)); }
  async clear(): Promise<void> {
    const next = this.serial.then(async () => {
      const keys = JSON.parse(await SecureStore.getItemAsync(this.indexKey) ?? "[]") as string[];
      await Promise.all(keys.map(key => SecureStore.deleteItemAsync(key)));
      await SecureStore.deleteItemAsync(this.indexKey);
    });
    this.serial = next.catch(() => {}); await next;
  }
}
