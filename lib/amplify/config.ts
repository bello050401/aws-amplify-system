import outputs from "@/amplify_outputs.json";

/**
 * amplify_outputs.json が実際のAWSデプロイ結果(Cognito/AppSync/S3のエンドポイント)
 * かどうかを判定する。プレースホルダーのままなら実AWSバックエンド未接続。
 *
 * ユーザーが `npx ampx sandbox` または `npx ampx pipeline-deploy` を実行すると
 * このファイルは自動的に実データで上書きされ、アプリは自動的に
 * AmplifyDataSource(実AWS)へ切り替わる。手動切り替えは不要。
 */
export const isAmplifyBackendConfigured = !(outputs as Record<string, unknown>).__PLACEHOLDER__;

let configured = false;

export function ensureAmplifyConfigured(): void {
  if (!isAmplifyBackendConfigured || configured) return;
  // 動的require: プレースホルダー時にaws-amplifyのconfigureへ無効な形状を渡さないため
  // isAmplifyBackendConfigured=falseの間はこの関数は何もしない。
  const { Amplify } = require("aws-amplify");
  Amplify.configure(outputs as never);
  configured = true;
}
