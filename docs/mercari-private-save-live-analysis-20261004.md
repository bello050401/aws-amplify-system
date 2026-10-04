# 既存商品の非公開保存1回: 観測と未確認事項（2026-10-04）

この文書は旧試行時点の観測記録である。現在採用する経路と次の判断は [直接連携の次の観測境界](mercari-first-listing-preflight-20261004.md) を参照する。

## 実機の事実

- 対象は既存B005795、既存商品ID `2JXePE4ke8UCBTj6mxc4cf`、価格90,000円、数量0。新規作成・公開は実行していない。
- PCアプリの1回ボタンで永続試行マーカーが作成され、結果 `BLOCKED_BEFORE_CLICK` が記録された。旧実装のこの結果が保証するのは、コードが最終の「非公開で保存する」クリックを呼ぶ前に停止したことだけである。「公開設定に進む」のクリックや、それに伴う送信がなかった証明ではない。最終クリック前の停止段階コードは記録されていないため、この試行について原因をさらに特定できない。マーカーは削除せず、再送しない。
- 専用ChromeのPC画面に表示された非秘密の通信概要は13件。順序11は `POST mercari-shops.com/graphql`、HTTP 200、Cookieあり、JSON項目名/型に `input.status`、`input.price`、`input.condition`、`input.variants[].skuCode` などを含む。ほかにも同じGraphQLへのPOSTがある。どのクリックに対応するか、選択された操作名、GraphQLの`errors`、対象ID/状態を含む応答は確認できない。HTTP 200のみで商品保存成功とは判定しない。
- この後、本人が「非公開で保存した」と申告した。操作したブラウザーは未確定であり、上記13件に含まれると断定しない。専用Chromeの観測範囲外で行われた可能性もある。
- 別の読取では、非公開一覧の対象行に「非公開 / ￥90,000 / 在庫0」が表示され、タイトルから同じ既存IDの編集画面へ戻れた。表示更新時刻は従前のまま。既存状態の保全は確認できるが、今回の保存の成功証拠ではない。

## PC画面に残る13件の非秘密通信概要

以下は稼働中の旧PCアプリが表示した順序・送信先の分類・HTTP状態・JSON項目名と型だけの転記。要求本文、項目値、認証キー、URLの可変部分、応答本文は含めない。全件で認証ヘッダーとCSRFヘッダーは表示上「なし」、応答内の商品ID・公開状態は「未確認」だった。`Cookieあり` はCookieの**存在フラグ**だけを示し、値は含まない。

| 順序 | 送信先・状態 | Cookie | 観測されたJSON項目名と型 |
| --- | --- | --- | --- |
| 1 | 外部HTTPS、200 | なし | なし |
| 2 | 外部HTTPS、204 | あり | なし |
| 3 | Shops GraphQL、200 | あり | `operationName:string`, `variables:object`, `query:string` |
| 4 | Shops GraphQL、200 | あり | 3の項目に加え `variables.input`, `input.name:string`, `input.description:string` |
| 5 | 外部HTTPS、204 | なし | なし |
| 6 | Shops GraphQL、200 | あり | 3と同じ |
| 7 | 外部HTTPS、204 | あり | なし |
| 8 | 外部HTTPS、204 | なし | なし |
| 9 | 外部HTTPS、204 | なし | なし |
| 10 | 外部HTTPS、200 | なし | なし |
| 11 | Shops GraphQL、200 | あり | `operationName:string`, `variables:object`, `variables.input`, `input.name:string`, `input.status:string`, `input.description:string`, `input.price:number`, `input.condition:string`, `input.shippingFromStateId:string`, `input.variants:array`, `variants[]:object`, `variants[].name:string`, `variants[].skuCode:string`, `query:string` |
| 12 | Shops GraphQL、200 | あり | 3と同じ |
| 13 | Shops GraphQL、200 | あり | 3と同じ |

順序1の外部HTTPS送信先は旧表示で `/:value` と分類された。順序11の`status`は**項目名と型**であり、値は未確認。HTTP 200も保存成功の証拠ではない。

## 今ある13件から判定できないこと

現在の観測器は操作名の**値**を捨て、項目名と型だけを保持する。GraphQL応答の`errors`有無と認識外の応答キーも保持しない。観測器が返したID/状態は全件未確認だった。元のリクエスト・レスポンス本文を復元しようとせず、今回の結果は未確認として扱う。

## 次の観測に必要な最小メタデータ

同じ専用Chromeの正規操作で新たな試行が許可された場合に限り、本文や資格情報を保存せず、メモリ内の表示を使う。下記2・3の表示実装は現在の作業ブランチに追加したが、今回稼働中のPCアプリには反映していない。既存の13件の詳細は復元できない。

1. 観測順序に加え、操作前・「公開設定に進む」後・最終保存後の**段階コード**。本人操作は別の段階として記す。
2. GraphQLの`operationName`を識別子書式と長さで検証した上でローカル表示する。安全に保持できない名前は表示しない。クエリ本文・変数値は表示しない。
3. GraphQL応答の`errors`有無、`data`の直下キー名、既存商品IDとの一致真偽値、公開状態の既知enum。エラー本文や任意の値は表示しない。
4. 観測した要求の完了/未完了は今後の追加候補。現状もHTTP 200だけでGraphQL処理成功としない。

これだけで管理画面HTTPの正確な書込契約や新規出品可否は証明できない。現在の方針である正規ログイン済みブラウザ経路では、実際の画像選択からアップロード完了、非公開保存の要求・応答・読戻しをそれぞれ同じ試行として確認する必要がある。B005795の保存を重ねたり、公開操作で代用したりしない。
