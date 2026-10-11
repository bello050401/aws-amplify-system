# メルカリShops下書きHTTP書込部の準備境界（2026-10-12）

Downloadsの既存HARから値を出さずにGraphQL文書の宣言とフィールド引数を再確認した。作成は `CreateProductDraft($input: CreateProductDraftInput!, $idempotencyKeySeed: Float!)` → `createProductDraft(createProductDraftInput: $input, idempotencyKeySeed: $idempotencyKeySeed)`、更新は `UpdateProductDraft($input: UpdateProductDraftInput!)` → `updateProductDraft(updateProductDraftInput: $input)`。画像asset登録はHTTP 200応答を観測済みだが、multipart要求本文はHARにない。これらは管理画面の観測であり、公開API契約ではない。

`webHttpObservedDraftWrite.ts` に、サーバー専用・送信先固定の**一回のGraphQL mutation**を準備した。BELLOの通常画面、Server Action、API route、ジョブ実行器からは呼ばない。`fetch` と認証Cookieは信頼できるサーバー呼出元からのみ渡す設計で、このリポジトリには本番呼出元と画像asset証明の作成器がない。画像ファイル送信処理もない。

1. 凍結済みBELLOジョブと既存のDynamoDB予約の要求ID・試行ID・店舗枠・4秒の送信期限を照合する。店舗枠の次回可能時刻は、この送信期限から30秒以上後でなければならない。
2. BELLO原画像の同一バイトから登録済みasset IDを得た証明、1画像制限、凍結ジョブに対応する入力マッピング証明を要求する。更新には対象下書きIDと同じジョブの読取証明も要求する。いずれの証明も現状では生成できない。
3. BELLOの既存紐付けがなく、同じ認証状態で `OwnShops` が対象店舗を含み、下書き全ページの重複調査が作成なら不在、更新なら対象1件のみと確認できた場合だけ次へ進む。これらの読取アダプターは未接続。
4. 送信の直前にDynamoDBの試行状態を `RESERVED_NO_SEND` から `SEND_CLAIMED_RESULT_UNKNOWN` へ**条件付きで一度だけ**変える。結果不明や同じ予約の再実行ではmutationを送らない。期限切れ、認証切れ、店舗不一致、リダイレクトも停止する。HTTP応答が不明なら既存の読取照合へ進み、0件でも再送を許可しない。

これは「作成応答で下書きIDを受けた」「更新応答で同じ下書きIDを受けた」までの限定処理で、商品完成や出品成功ではない。一つの予約からはmutationを1件しか送らない。**作成後の更新には別の予約と対象下書きの永続的な紐付けが必要**だが、現行の予約は同じジョブの2回目を拒否するため、連続した下書き完成フローは未実装。既知のB005396は既存下書き2件があるので常に書込禁止。

未観測・未接続の項目は、画像multipartの本文とBELLO画像バイトとの照合、asset証明の取得、商品項目・カテゴリ・配送・enum値の確定マッピングとseedの意味、認証Cookieの安全な保存と更新、重複調査の全ページ読取アダプター、更新用の別予約、実行環境での接続、公開・停止のHTTP契約である。BASEとPCの既存経路は変更していない。商品作成・更新・画像アップロード・公開・停止の実通信は本作業では一切行っていない。
