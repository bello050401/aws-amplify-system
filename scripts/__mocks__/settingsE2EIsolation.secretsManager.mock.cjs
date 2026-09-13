// scripts/verify-settings-e2e-isolation.ts 専用スタブ。
//
// lib/zaico/secretStore.ts・lib/messaging/line/secretStore.ts・
// lib/listing/mercari/secretStore.ts・lib/base/secretStore.tsは、それぞれ
// 独立に`new SecretsManagerClient({region})`して`.send(new
// GetSecretValueCommand(...))`する。fixtureモードで実際にこの経路へ
// 到達していないかを、送信回数を記録した上でthrowして確かめる——
// 呼び出し側がtry/catchで握りつぶす設計(実際にそう作られている、例:
// getZaicoTokenFromSecretsManagerは失敗時null/false相当を返す)なので、
// 「例外が外まで伝播しないこと」だけでは「呼ばれなかったこと」を証明
// できない。__callsを見て初めて判定できる。
const calls = [];

class StubSecretsManagerClient {
  send(command) {
    calls.push({ commandName: command?.constructor?.name ?? "(unknown)", input: command?.input ?? null });
    return Promise.reject(
      new Error("[settingsE2EIsolation] SecretsManagerClient.send() was called — fixture mode must never reach AWS Secrets Manager"),
    );
  }
}
class StubCommand {
  constructor(input) {
    this.input = input;
  }
}
class StubResourceNotFoundException extends Error {}
class StubResourceExistsException extends Error {}

module.exports = {
  SecretsManagerClient: StubSecretsManagerClient,
  GetSecretValueCommand: StubCommand,
  PutSecretValueCommand: StubCommand,
  CreateSecretCommand: StubCommand,
  ResourceNotFoundException: StubResourceNotFoundException,
  ResourceExistsException: StubResourceExistsException,
  __calls: calls,
  __resetCalls: () => {
    calls.length = 0;
  },
};
