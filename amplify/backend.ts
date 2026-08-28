import { defineBackend } from "@aws-amplify/backend";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { storage } from "./storage/resource";

/**
 * BELLO在庫管理システム Amplify Gen2 バックエンド定義。
 *
 * デプロイ方法(ユーザー本人のAWS認証が必要。指示書 §32):
 *   npx ampx sandbox            # 開発用サンドボックス
 *   npx ampx pipeline-deploy    # CI/CD本番デプロイ
 *
 * デプロイすると amplify_outputs.json が生成され、Next.jsアプリは
 * 自動的にこの実バックエンド(Cognito/AppSync/DynamoDB/S3)を使用する。
 * (lib/amplify/backendConfig.ts 参照。amplify_outputs.json が無い場合は
 *  ローカル動作確認用のモックリポジトリにフォールバックする)
 */
defineBackend({
  auth,
  data,
  storage,
});
