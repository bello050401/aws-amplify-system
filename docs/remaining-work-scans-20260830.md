# Remaining Work Scan #1 / #2(第五ラウンド §P3)

作成日: 2026-08-30。第五ラウンド仕様書の要求により、異なる視点で2回
独立に実施。

## Scan #1: grep型(TODO/FIXME/未実装/stub/mock/hardcoded/browser-driven-loop)

`TODO|FIXME|XXX|HACK|SPEC_UNCONFIRMED|未実装|not yet implemented` 等を
リポジトリ全体に対して実行し、ヒットした全箇所(50件超)を個別に確認した。

**結果**: 新規に修正可能な項目は無かった。ヒットの内訳:
- 大半は、前ラウンドまでに「なぜ未実装か」の理由(実写真テストセット
  無し/公式API仕様未確認/AWS未接続)が既に明記された、正直な
  `throw new Error("...未実装です...")`パターン(Mercari問い合わせAPI、
  Yahoo!オークションストア、画像segmentation/床クリーニング/RAW現像、
  BASE画像同期、pricing schedulerの実際のMercari価格変更API呼び出し)
  ——いずれも「fake success禁止」の原則に沿って正直に失敗を返す設計
  であり、隠れたバグではない。
- 残りは第三者パッケージ(`@aws-amplify/data-schema`)のソースコードを
  引用したコメント(`// TODO: delete when we...`)で、このリポジトリの
  未対応作業ではない。
- ハードコードされたAPIキー/シークレットのパターン検索
  (`(api_key|secret|token)\s*[:=]\s*["'][A-Za-z0-9+/=_-]{20,}["']`)は
  0件(このラウンドで追加したE2Eテスト専用トークン文字列
  `"e2e-local-test-token-not-a-real-secret-32c"`はplaywright.config.ts/
  spec内にのみ存在し、実運用の秘密情報とは無関係)。
- 空の`catch {}`(エラー握りつぶし)パターンも0件。

このScanの過程で見つかった**実際に修正した**問題は、既にP0-B/P0-C/
P1-Cの各ドキュメントに記録済み(GSI/Scan、ページング欠如2件、
InventoryHistory等5箇所のGSI化、ProcessingJob二重処理防止)。

## Scan #2: 逆算型(コード→仕様、Scan #1とは異なる角度)

到達不能/未接続な機能・Production/secret名の越境・updatedAtの副作用・
冪等性の破れ・「テストの中だけ通る」パターンを探した。

1. **`lib/inventory/masterDedupe.ts`のdedupeMasterEntries — 呼び出し
   経路の確認**: `app/inventory/(protected)/settings/page.tsx`から
   実際に呼ばれていることを確認(到達不能ではない)。
2. **`app/actions/imageProcessing.ts`の`reprocessImageAction` —
   FAILED/DEAD_LETTERジョブの手動再加工の到達性確認**:
   `ImageProcessingPanel.tsx`の「再加工」ボタンから実際に呼ばれている
   ことを確認。image-processing-workerのcatch節が「3回失敗した
   ジョブ行はDEAD_LETTERへ、それ未満はFAILEDへ」とするだけで**自動
   再試行はしない**設計(スケジュールLambdaはPENDING行しかScanしない
   ため)だが、これは「無限自動リトライを避ける」という既存コメントの
   意図通りであり、人間が明示的に「再加工」ボタンを押すことで新しい
   ProcessingJob行(同じidempotencyKey)が作られる、という設計——バグ
   ではなく意図的な「自動リトライ回数の上限」+「手動再試行は別途
   可能」という2層構造。
3. **secret名/Production越境チェック**: `amplify/backend.ts`・
   `amplify/functions/*/resource.ts`内に`"main"`/`"production"`の
   ハードコード参照が無いことを確認。ZAICO Secret名
   (`bello/zaico-api-token`)は`lib/zaico/secretStore.ts`と
   `amplify/functions/zaico-sync-worker/zaicoApiClient.ts`の2箇所で
   完全一致する定数として重複定義されている(意図的——両者は独立した
   実行境界のため、共有importより重複の方が安全という既存の設計方針、
   このセッションの要約に記載の通り)。ブランチ名のハードコードは
   無し。
4. **updatedAtの副作用**: `lib/inventory/thumbnailBackfill.ts`の
   既知の例外(サムネイル遡及生成がupdatedAtを意図せず更新する)は
   既に文書化済み、変更なし。今回追加したP0-B/P0-Cの変更
   (`useInventoryImageUrl.ts`のキャッシュ、GSI Query化)は
   いずれもDynamoDBへの書き込みを一切伴わない読み取り専用の変更
   であり、新たなupdatedAt副作用は生じない。
5. **冪等性の破れの再確認**: 第五ラウンドP0-Aで新設した
   `zaico-sync-worker`のLambdaが、チェックポイント書き込み前に
   クラッシュした場合を検証——再試行時は同じページを
   `port.fetchAllZaicoManaged()`で**再度full prefetch**してから
   `syncOneZaicoItem`を呼ぶため、既に作成済みの商品(前回試行の
   途中で作られたもの)はprefetchのMapに含まれ、`syncOneZaicoItem`が
   正しく「既存」と判定し二重作成しない——既存のZAICO同期の冪等性
   設計(`sourceInventoryId`による照合)がLambda化後も維持されている
   ことをコードレビューで確認。
6. **「テストの中だけ通る」パターンの確認**: 第五ラウンドP1-Aで
   追加したE2E fixture/認証bypassが、`npm run build`
   (NODE_ENV=production)で構造的に無効化されること、および
   `verify:*`テストスイート・型チェック・lintのいずれもこの
   bypassの存在に依存していない(bypassが無くても既存テストは
   全て独立して成立する)ことを確認——テストを通すためだけに本番
   コードの動作を変えるような仕込みは無い。

**結論**: Scan #1/#2のいずれからも、今回のラウンドで新たに修正すべき
実装可能な不具合は(既にP0-B/P0-C/P1-Cで対応した項目を除き)発見
されなかった。既存のSPEC_UNCONFIRMED/未実装項目は、いずれも実写真・
外部API公式仕様・AWS実環境という、このセッション内では用意できない
リソースへの依存が理由であり、正直に「未実装」と表示・記録されている
ことを再確認した。
