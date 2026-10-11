# メルカリShops下書きHTTP書込部の準備境界（2026-10-12）

Downloadsの既存HARから値を出さずにGraphQL文書の宣言とフィールド引数を再確認した。作成は `CreateProductDraft($input: CreateProductDraftInput!, $idempotencyKeySeed: Float!)` → `createProductDraft(createProductDraftInput: $input, idempotencyKeySeed: $idempotencyKeySeed)`、更新は `UpdateProductDraft($input: UpdateProductDraftInput!)` → `updateProductDraft(updateProductDraftInput: $input)`。画像asset登録はHTTP 200応答を観測済みだが、multipart要求本文はHARにない。これらは管理画面の観測であり、公開API契約ではない。

`webHttpObservedDraftWrite.ts` に、サーバー専用・送信先固定の**一回のGraphQL mutation**を準備した。BELLOの通常画面、Server Action、API route、ジョブ実行器からは呼ばない。`fetch` と認証Cookieは信頼できるサーバー呼出元からのみ渡す設計で、このリポジトリには本番呼出元と画像asset証明の作成器がない。画像ファイル送信処理もない。

1. 凍結済みBELLOジョブと既存のDynamoDB予約の要求ID・試行ID・店舗枠・4秒の送信期限を照合する。さらに送信直前のBELLO在庫レコードをUUIDで読み直し、現在の `id`・`sku` が凍結ジョブの在庫ID・元在庫コードと一致することを要求する。店舗枠の次回可能時刻は、この送信期限から30秒以上後でなければならない。
2. BELLO原画像の同一バイトから登録済みasset IDを得た証明、1画像制限、凍結ジョブに対応する入力マッピング証明を要求する。更新には対象下書きIDと同じジョブの読取証明も要求する。いずれの証明も現状では生成できない。
3. BELLOの既存紐付けがなく、同じ認証状態で `OwnShops` が対象店舗を含み、下書き全ページの重複調査が作成なら不在、更新なら対象1件のみと確認できた場合だけ次へ進む。これらの読取アダプターは未接続。
4. 送信の直前にDynamoDBの試行状態を `RESERVED_NO_SEND` から `SEND_CLAIMED_RESULT_UNKNOWN` へ**条件付きで一度だけ**変える。結果不明や同じ予約の再実行ではmutationを送らない。期限切れ、認証切れ、店舗不一致、リダイレクトも停止する。HTTP応答が不明なら既存の読取照合へ進み、0件でも再送を許可しない。

これは「作成応答で下書きIDを受けた」「更新応答で同じ下書きIDを受けた」までの限定処理で、商品完成や出品成功ではない。一つの予約からはmutationを1件しか送らない。**作成後の更新には別の予約と対象下書きの永続的な紐付けが必要**だが、現行の予約は同じジョブの2回目を拒否するため、連続した下書き完成フローは未実装。既知のB005396は既存下書き2件があるので常に書込禁止。

未観測・未接続の項目は、画像multipartの本文とBELLO画像バイトとの照合、asset証明の取得、商品項目・カテゴリ・配送・enum値の確定マッピングとseedの意味、認証Cookieの安全な保存と更新、重複調査の全ページ読取アダプター、更新用の別予約、実行環境での接続、公開・停止のHTTP契約である。BASEとPCの既存経路は変更していない。商品作成・更新・画像アップロード・公開・停止の実通信は本作業では一切行っていない。

`webHttpObservedDraftInputMapper.ts` には、送信を行わない入力マッパーを追加した。凍結ジョブに対し、現在のBELLO在庫と保存済みEC下書き・選択カテゴリ・既存紐付け・リモート重複の完全読取・原画像SHA-256を再照合する。販売済み、発送完了、在庫0、既存商品、B005396は停止する。観測済みの単一画像かつブランド未指定の形だけを扱い、価格・数量・カテゴリは管理者選択の証明と一致させる。[B005396のBELLO画面](mercari-general-private-form-only-20261008.md)の状態「目立った傷や汚れなし」と[同商品のHAR](mercari-b005396-http-draft-har-evidence-20261009.md)の更新入力 `CONDITION_CLEAN` の組だけを認め、他の状態は停止する。この組にも、現在の商品に対する人手確認証明を要求する。店舗依存の `countryRestrictionTemplateId` / `channelListingScope` と作成seedも確認済み証明がない限り生成しない。結果は `MAPPED_NO_SEND` と `allowHttpWrite:false` であり、実行経路には接続していない。現状、これらの証明とリモート完全読取を作る本番アダプターがない。マッピング後に在庫状態が変わり得るため、将来の書込時には販売状態と保存済み下書きを再照合する必要がある。

在庫IDの監査では、`5b0f3587-cbbb-4c09-ae78-595b2b3e353f` はB005413、`c9ee4ea7-070f-491c-bd4c-c1547cb73436` はB005757として既存コード・記録で一貫していた。B005396のコード上の固定UUIDは別の `2c53f36a-7a60-4e34-801d-8abc24f6cfc0`。前2者をB005396として扱う記述は見つからなかった。書込部は現在の在庫SKUが `B005396` ならUUIDにかかわらず停止する。

同日のBELLO実画面で、B005396はこの固定UUIDのHUKLA KASTORと確認された。現在カテゴリは「発送完了」、販売終了日は2026-09-15、販売市場はメルカリSHOPで注文IDもある。この商品を新規公開の試験対象にしない。既存Shops下書き2件は読取・画像通信の観測対象に限定し、作成・更新・公開・停止を送らない。
