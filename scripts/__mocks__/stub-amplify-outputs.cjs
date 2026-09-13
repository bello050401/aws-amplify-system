/**
 * scripts/verify-listings-overview-service-boundary.ts 用のamplify_outputs.
 * json代替。
 *
 * lib/listing/service.tsはmercari/adapter.ts経由でlib/amplify/serverUtils.ts
 * (@/amplify_outputs.jsonを実importする)を引き込むが、listListingsOverview
 * の実行経路はrunWithAmplifyServerContextを一度も呼ばない(mercari publish
 * 専用)ので中身の値自体はダミーで良い——モジュール解決さえ通ればよい。
 *
 * .cjs にしているのはNode ESMの生JSON importが要求する
 * `with { type: "json" }` importアトリビュートを回避するため
 * (このリポジトリのソース側はTSのbundler解決前提でアトリビュート無しの
 * `import outputs from "@/amplify_outputs.json"`と書いており、それ自体は
 * 変更しない)。値はlib/inventory/e2eFixtures.tsのコメントが説明する
 * ローカル未デプロイプレースホルダ規約(`localstub.appsync-api...`)に
 * 合わせてある。
 */
module.exports = {
  version: "1.3",
  auth: {
    user_pool_id: "localstub_user_pool",
    aws_region: "us-east-1",
    user_pool_client_id: "localstub_client",
    identity_pool_id: "us-east-1:localstub",
    mfa_methods: [],
    standard_required_attributes: ["email"],
    username_attributes: ["email"],
    user_verification_types: ["email"],
    unauthenticated_identities_enabled: true,
    password_policy: {
      min_length: 8,
      require_lowercase: true,
      require_numbers: true,
      require_symbols: true,
      require_uppercase: true,
    },
    mfa_configuration: "NONE",
  },
  data: {
    url: "https://localstub.appsync-api.us-east-1.amazonaws.com/graphql",
    aws_region: "us-east-1",
    api_key: "localstub-api-key",
    default_authorization_type: "AWS_IAM",
    authorization_types: ["AMAZON_COGNITO_USER_POOLS", "API_KEY"],
  },
  storage: {
    aws_region: "us-east-1",
    bucket_name: "localstub-bucket",
  },
};
