# Mercari Shops API接続 HTTP 404 — 再調査・訂正記録

作成日: 2026-08-30。対応指示書: 「不具合修正・ZAICO同期重複根絶・
EC出品UI改善・画像自動加工 完全自律実装指示書」§4。

## 前回までの調査(訂正対象)

`lib/listing/mercari/endpoints.ts`の既存コメント(直近ラウンドの調査)
は、以下2点を結論としていた:

1. Mercari Shops API公式ドキュメントに記載の固定IPアドレス(CIDR
   表記)は、**Mercari自身がWebhookを送信してくる送信元IP**であり、
   BELLO→MercariのAPI発信には無関係。
2. `client.ts`が`User-Agent`ヘッダを一切送っていなかったことが、
   API Gateway/WAF層での404の有力な原因候補(ただしAWS環境が無く
   実証不可)。

(2)は既に別ラウンドで修正済み(`client.ts`は現在`User-Agent`を
送信している)。しかし(1)の結論は、今回の再調査で**誤りだったことが
判明した**。

## 今回の再調査で新たに判明した事実

このラウンドでも`https://api.mercari-shops.com/docs/index.html`への
直接WebFetchは引き続きブロックされている(`EGRESS_BLOCKED`)。しかし、
**複数の独立したWebSearchクエリ**で、検索エンジンが保持する同じ公式
ドキュメントページの要約から、一貫して以下の内容を確認できた:

> Requests from IP addresses that haven't been registered return a 404
> NotFound error; IP address registration may be needed as required.
> ... Registration of a fixed IP address is required even in the
> sandbox environment ... Permitted IP addresses are managed separately
> for the Sandbox environment and the production environment ...
> Individual IP addresses (host addresses) must be registered; IP
> range specifications are not possible.

つまり:

- **sandbox環境を含め、APIを呼び出す側(BELLO)の送信元IPアドレスを
  個別に事前登録する必要がある**(IP範囲指定は不可)。
- 許可IPアドレスはsandbox/production環境ごとに別々に管理される。
- **未登録のIPアドレスからのリクエストは、403ではなく404
  NotFoundを返す。**

これは実際に報告された症状(「HTTP 404: Not Found」)と、ステータス
コードまで含めて完全に一致する——前回調査より遥かに具体的で、
実際の症状を直接説明できる根本原因候補である。

## 現状のBELLOのネットワーク構成との関係

BELLOはAWS Amplify HostingのSSRコンピュート上で動作しており、
**固定の送信元IPアドレスを持たない**(NAT Gateway等を導入していない
——前回の(誤った)結論に基づき「不要」と判断していたため)。つまり、
現在の構成のままでは、たとえTOKEN・APIクライアント名・User-Agentが
全て正しくても、**送信元IPが未登録である限り、Mercari Shops APIへの
リクエストは全て404で失敗する**——これが実際に報告された404の、
最も有力かつ症状と完全に一致する原因だと結論する。

## 修正した内容(コード側、今回のラウンドで完結する範囲)

1. `lib/listing/mercari/errors.ts`:
   - `classifyHttpStatus(404)`が`UNKNOWN_REMOTE_ERROR`(「不明な
     エラー」)ではなく`IP_NOT_ALLOWED`を返すよう修正。
   - `MERCARI_ERROR_LABEL.IP_NOT_ALLOWED`のメッセージを、「アクセス元
     が許可されていません（IP制限の可能性があります）。」という
     曖昧な文言から、「アクセス元のIPアドレスがMercari側に未登録の
     可能性があります（固定IPアドレスの事前登録が環境ごとに必要
     です）。契約担当者経由でMercariへ登録を依頼してください。」
     という、実際に取るべき行動が分かる具体的な文言へ更新。
2. `lib/listing/mercari/client.ts`: §4.3が求める安全な診断ログを追加
   ——TOKEN本体は一切出さず、endpoint/environment/GraphQL operation
   name/User-Agent設定有無(真偽値)/token present(真偽値)/token
   lengthのみをログへ出す(`extractGraphQLOperationName`新設)。
3. `lib/listing/mercari/endpoints.ts`: 上記の訂正内容をコメントへ
   反映。

## 完全な解決に必要な、コードでは代替できない残作業

根本的な解決には、以下2つが**両方**必要である。いずれもBELLO側の
コード変更だけでは完結しない:

1. **AWSインフラ変更**: BELLOの出力(egress)通信を固定IPアドレス
   経由にする(典型的にはVPC + NAT Gateway + Elastic IPの構成)。
   NAT Gatewayは継続的なAWS利用料が発生するため、既存の§125(AWS
   コスト方針)に照らした導入判断が必要——このラウンドではAWS
   認証情報が無効なため実装・デプロイ自体ができない
   (`docs/aws-staging-reverify-20260830.md`参照)。
2. **Mercariとの契約手続き**: (1)で確保した固定IPアドレスを、
   Mercariの契約担当者経由でsandbox環境・production環境それぞれに
   登録してもらう。これは**Mercariとの契約・登録作業そのもの**であり、
   コードでは絶対に代替できない、ユーザー本人(またはBELLOの契約
   担当者)が行う必要がある実作業。

## テスト

`scripts/verify-listing.ts`に5件追加(既存76件+新規5件=81件、全green):
- `classifyHttpStatus(404)`が`IP_NOT_ALLOWED`を返すこと(訂正した
  分類の回帰確認)。
- `IP_NOT_ALLOWED`が`isRetryableMercariErrorCode`でfalseになること
  (未登録IPは再試行しても直らないため)。
- `MercariApiError(IP_NOT_ALLOWED, ...)`のuser-facingメッセージが
  「固定IPアドレスの事前登録」という具体的な行動指針を含むこと。
- `extractGraphQLOperationName`が実際にこのコードベースで使われている
  query/mutation文字列から正しくoperation nameを抽出すること。

## 正直な分類

- コードの分類・診断ログ・メッセージ改善: **LOCAL_VERIFIED**
  (tsc/lint/`verify:listing` 81件全green)。
- 実際にMercari Shops APIへの接続が成功するかどうか: **未検証**
  (`BLOCKED_BY_EXTERNAL_SERVICE`寄り、かつ`BLOCKED_BY_USER`——AWS
  インフラ変更とMercariとの契約手続きの両方が完了して初めて検証
  可能)。「コードを直したので404は解消するはず」とは書かない——
  今回の根本原因特定そのものが、直接検証不可能な外部要因(未登録の
  固定IP)に基づく、複数の独立した検索結果からの推論であることを
  明記する。
