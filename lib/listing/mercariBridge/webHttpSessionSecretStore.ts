import "server-only";

import { GetSecretValueCommand, PutSecretValueCommand,
  type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { WebHttpSessionRecord, WebHttpSessionStore } from
  "./webHttpSessionLifecycle.ts";

/** Requires a separately provisioned, dedicated secret and least-privilege IAM. */
export class SecretsManagerWebHttpSessionStore implements WebHttpSessionStore {
  private readonly client: SecretsManagerClient;
  private readonly secretArn: string;

  constructor(client: SecretsManagerClient, secretArn: string) {
    if (!/^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:bello\/mercari-web-session-[A-Za-z0-9]+$/
      .test(secretArn)) throw new Error("Dedicated web session secret ARN required");
    this.client = client;
    this.secretArn = secretArn;
  }

  async read(): Promise<WebHttpSessionRecord | null> {
    const result = await this.client.send(new GetSecretValueCommand({
      SecretId: this.secretArn, VersionStage: "AWSCURRENT",
    }));
    if (typeof result.SecretString !== "string") throw Error("Session unavailable");
    const parsed: unknown = JSON.parse(result.SecretString);
    return parsed as WebHttpSessionRecord;
  }

  async write(record: WebHttpSessionRecord): Promise<void> {
    const secretString = JSON.stringify(record);
    if (Buffer.byteLength(secretString, "utf8") > 60 * 1024)
      throw Error("Session too large");
    await this.client.send(new PutSecretValueCommand({
      SecretId: this.secretArn,
      ClientRequestToken: record.sessionId,
      SecretString: secretString,
    }));
  }
}
