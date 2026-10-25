import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { SecurityError, type Vault } from "./types";
/** Envelope encryption: refresh tokens and Cognito challenges never persist in plaintext. */
export class KmsVault implements Vault {
  private client: KMSClient;
  constructor(readonly keyId: string, region: string, readonly deployment: string) { this.client = new KMSClient({ region }); }
  private context() { return { purpose: "BELLO-security-session", deployment: this.deployment }; }
  async seal(value: unknown) {
    const result = await this.client.send(new GenerateDataKeyCommand({ KeyId: this.keyId, KeySpec: "AES_256", EncryptionContext: this.context() }));
    if (!result.Plaintext || !result.CiphertextBlob) throw new SecurityError("VAULT_UNAVAILABLE", 503);
    const key = Buffer.from(result.Plaintext), iv = randomBytes(12);
    try {
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(this.deployment));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      return JSON.stringify({ v: 1, key: Buffer.from(result.CiphertextBlob).toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") });
    } finally { key.fill(0); result.Plaintext.fill(0); }
  }
  async open<T>(value: string): Promise<T> {
    const x = JSON.parse(value);
    if (x.v !== 1) throw new SecurityError("INVALID_VAULT", 503);
    const result = await this.client.send(new DecryptCommand({ KeyId: this.keyId, CiphertextBlob: Buffer.from(x.key, "base64"), EncryptionContext: this.context() }));
    if (!result.Plaintext) throw new SecurityError("VAULT_UNAVAILABLE", 503);
    const key = Buffer.from(result.Plaintext);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(x.iv, "base64"));
      decipher.setAAD(Buffer.from(this.deployment));
      decipher.setAuthTag(Buffer.from(x.tag, "base64"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(x.data, "base64")), decipher.final()]).toString());
    } finally { key.fill(0); result.Plaintext.fill(0); }
  }
}
