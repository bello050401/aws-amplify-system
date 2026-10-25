import "server-only";
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export const ECONVENI_SECRET_ID = "bello/econveni-credentials";
export interface EconveniCredentialsState {
  configured: boolean;
  updatedAt: string | null;
}
interface Payload {
  schemaVersion: 1;
  configured: boolean;
  loginId?: string;
  password?: string;
  updatedAt?: string;
  updatedBy?: string;
}
export class EconveniInputError extends Error {}
export class EconveniStorageError extends Error {
  constructor() { super("eコンビニの接続設定を確認できませんでした。時間をおいて再度お試しください。"); }
}
export function validateEconveniCredentials(input: unknown): { loginId: string; password: string } {
  if (!input || typeof input !== "object") throw new EconveniInputError("ログインIDとパスワードを入力してください。");
  const { loginId, password } = input as Record<string, unknown>;
  if (typeof loginId !== "string" || !loginId.trim() || typeof password !== "string" || !password.trim()) {
    throw new EconveniInputError("ログインIDとパスワードを入力してください。");
  }
  if (loginId.length > 256 || password.length > 1024 || /[\u0000-\u001f\u007f]/.test(loginId + password)) {
    throw new EconveniInputError("入力内容を確認してください。改行や制御文字は使用できません。");
  }
  // Passwords are opaque: do not trim or normalize a valid password.
  return { loginId: loginId.trim(), password };
}
type SecretClient = { send(command: GetSecretValueCommand | PutSecretValueCommand): Promise<{ SecretString?: string }> };

/** The fixed Secret exists before deployment. The web role cannot create/list secrets. */
export class EconveniCredentialStore {
  constructor(private readonly client: SecretClient) {}
  private async read(): Promise<Payload> {
    try {
      const result = await this.client.send(new GetSecretValueCommand({ SecretId: ECONVENI_SECRET_ID, VersionStage: "AWSCURRENT" }));
      const payload = JSON.parse(result.SecretString ?? "null") as Payload | null;
      if (!payload || payload.schemaVersion !== 1 || typeof payload.configured !== "boolean") throw new EconveniStorageError();
      if (payload.configured && (typeof payload.loginId !== "string" || !payload.loginId || typeof payload.password !== "string" || !payload.password)) {
        throw new EconveniStorageError();
      }
      return payload;
    } catch {
      // Never echo AWS exception bodies or stored input; missing/denied is not "unconfigured".
      throw new EconveniStorageError();
    }
  }
  async state(): Promise<EconveniCredentialsState> {
    const payload = await this.read();
    return { configured: payload.configured, updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : null };
  }
  /** For the server-side login adapter only. Not exported by any action/route. */
  async credentials(): Promise<{ loginId: string; password: string } | null> {
    const payload = await this.read();
    return payload.configured ? { loginId: payload.loginId!, password: payload.password! } : null;
  }
  async save(input: unknown, actor: string): Promise<EconveniCredentialsState> {
    const values = validateEconveniCredentials(input);
    const updatedAt = new Date().toISOString();
    const payload: Payload = { schemaVersion: 1, configured: true, ...values, updatedAt, updatedBy: actor };
    try {
      await this.client.send(new PutSecretValueCommand({ SecretId: ECONVENI_SECRET_ID, SecretString: JSON.stringify(payload) }));
    } catch { throw new EconveniStorageError(); }
    return { configured: true, updatedAt };
  }
}
export const econveniCredentialStore = new EconveniCredentialStore(
  new SecretsManagerClient({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2" }),
);
