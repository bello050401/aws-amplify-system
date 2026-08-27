import { randomBytes } from "crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, maskSecret } from "./crypto";

describe("crypto (Personal API Access Token encryption, 指示書32, 56項)", () => {
  beforeAll(() => {
    // テスト用の暗号化キーを用意する（本番の.envとは無関係）。
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });

  it("round-trips a plaintext token through encrypt/decrypt", () => {
    const plain = "sandbox_test_token_1234567890";
    const encrypted = encryptSecret(plain);
    expect(encrypted).not.toBe(plain);
    expect(decryptSecret(encrypted)).toBe(plain);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const plain = "same-plaintext-token";
    const a = encryptSecret(plain);
    const b = encryptSecret(plain);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(plain);
    expect(decryptSecret(b)).toBe(plain);
  });

  it("fails to decrypt with a tampered payload (auth tag check)", () => {
    const encrypted = encryptSecret("some-token");
    const tampered = encrypted.slice(0, -4) + "abcd";
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("masks a secret without revealing the full value", () => {
    const masked = maskSecret("sandbox_test_token_1234567890");
    expect(masked.startsWith("sand")).toBe(true);
    expect(masked).not.toContain("test_token");
  });
});
