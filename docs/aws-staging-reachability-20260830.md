# AWS認証情報・ステージング到達可能性の再検証(第五ラウンド P1-B)

作成日: 2026-08-30。第五ラウンド仕様書の指示通り、過去ラウンドの
BLOCKED判定を無条件に継承せず、今回改めて機械的に再検証した。

## 再検証手順と結果

1. `env | grep AWS_` — `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`が
   環境変数として**存在すること自体は確認**(過去ラウンドの前提だった
   「環境変数すら無い」状況とは異なる)。ただし値はいずれも文字列
   `"proxy-injected"`——このセッションのegress proxy機構が特定の
   外部サービス(例: GitHub、`GH_TOKEN=proxy-injected`は実際に
   GitHub MCP経由で機能している)向けにプレースホルダをその場で実値へ
   置換する設計であることを示す命名パターンであり、それ自体が
   「有効なAWSクレデンシャルの値」であることを意味しない。
2. `which aws` — AWS CLI自体がインストールされていない
   (`aws: command not found`)。
3. 実際にAWS SDK(`@aws-sdk/client-sts`、既にリポジトリの依存に含まれる
   バージョンをそのまま使用)で`GetCallerIdentity`を実行——**推測や
   コードレビューではなく、実際にネットワーク越しにAWS STSエンドポイント
   へ到達させた**:
   ```
   FAILED: InvalidClientTokenId - The security token included in the
   request is invalid.
   httpStatusCode: 403, requestId: 3a2d7d4d-24a3-4148-b195-103695933dee
   ```
4. `curl http://127.0.0.1:33237/__agentproxy/status` — egress proxy
   自体は正常稼働しており(`enabled: true`)、AWS宛のリクエストを
   ブロック/拒否しているのではなく、**実際にAWS側まで届いた上で
   AWS自身が「このクレデンシャルは無効」と応答している**ことが
   requestId付きの本物のSTSエラーレスポンスから確認できる。

## 結論(機械的に確定、推測ではない)

- **ネットワーク到達性**: このセッションからAWS(少なくともSTSの
  us-east-1エンドポイント)への経路は**通っている**——過去ラウンドが
  想定していたかもしれない「そもそもAWSへ到達できないネットワーク
  制限」ではない。
- **認証情報**: このセッションに設定されている`AWS_ACCESS_KEY_ID`/
  `AWS_SECRET_ACCESS_KEY`は、実際のAWSアカウントに対して有効な
  クレデンシャルではない(`InvalidClientTokenId`は「形式は正しいが
  実在しないaccess key」に対する典型的なSTSの応答)。
- したがって、`ampx sandbox`/`ampx pipeline-deploy`等によるAWS
  Amplifyステージングへの実デプロイ、App ID `d4hkkg7dty2du`への
  実際のブランチ追加・ビルド確認は、**今回も引き続き実行不能
  (BLOCKED_BY_USER)** ——ただし今回は「クレデンシャルが無いから」
  ではなく「クレデンシャルは設定されているが実際には無効、かつ
  それを有効化する手段(AWS SSO/MFAでの再ログイン等)はこの
  session内のいかなるツールにも存在しない」という、より具体的で
  再現可能な根拠に基づく。
- `docs/aws-test-environment.md`が記録するセットアップスクリプト
  (`scripts/aws-setup/*.ps1`)・IAMポリシー・App ID等の実行計画自体は
  今回変更していない——実行可能になった時点(ユーザーが自分の端末で
  AWS SSO認証を済ませた状態)でそのまま使える。

## 今回新たに確定した、次回以降の再検証手順(再利用可能)

次ラウンド以降、AWS認証情報が再び「無い/わからない」状態から
再監査する場合は、上記の手順4(`@aws-sdk/client-sts`で実際に
`GetCallerIdentity`を呼ぶ)を最初に実行することを推奨する——
`InvalidClientTokenId`(クレデンシャル自体が無効)と、
タイムアウト/DNS解決失敗(ネットワーク到達不能)は明確に異なるエラー
として区別でき、"AWS credentials/Cognito unreachable" という一括りの
BLOCKED理由よりも、次に何をすべきかを正確に切り分けられる。
