// scripts/verify-listings-overview-service-boundary.ts 専用スタブ。
// lib/listing/mercari/{relay,secretStore}.ts・lib/base/secretStore.ts が
// `@aws-sdk/client-secrets-manager`を使うが、いずれも実際にSecrets
// Managerへ触る関数の**内部**でだけ`new SecretsManagerClient()`する
// (モジュール読込時ではない)——この検証はそれらの関数を一切呼ばない
// ため、コンストラクタ/send()が実際に使われることは無い。呼ばれたら
// 分かるようthrowする(黙って成功したことにしない)。
class StubSecretsManagerClient {
  send() {
    return Promise.reject(new Error("[stub-aws-sdk-secrets-manager] SecretsManagerClient.send() was called but this test never expects it to run"));
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
};
