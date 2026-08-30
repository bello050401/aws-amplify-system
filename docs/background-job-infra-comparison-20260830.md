# Background Job基盤の横断比較(第五ラウンド §8 P1-C)

作成日: 2026-08-30。対象: ZAICO同期(`ZaicoSyncJob` +
`amplify/functions/zaico-sync-worker`)、画像自動加工
(`ProcessingJob` + `amplify/functions/image-processing-worker`)、
自動価格改定(`ChannelListing.nextPriceActionAt`駆動 +
`amplify/functions/pricing-scheduler`)の3つの無人スケジュールLambda。

方針: 第五ラウンド仕様書の指示通り、3つを1つの巨大な共通Jobクラスへ
強制統合することはしない——作業単位の形が根本的に異なる
(ZaicoSyncJobは「1つのsingleton行を複数tickにまたいで前進させる」、
ProcessingJob/pricing-schedulerは「多数の独立した行をそれぞれ1回で
処理する」)ため、無理に共通化すると却って各々の単純さを失う。
代わりに、各軸で実際の実装を突き合わせ、抜けている箇所だけを
今回のラウンドで補った。

## 比較表

| 観点 | ZaicoSyncJob | ProcessingJob | pricing-scheduler(ChannelListing) |
|---|---|---|---|
| 作業単位 | singleton 1行(`zaico-full-sync-singleton`)を複数回のtickにまたいで前進 | 1行=1画像、独立 | 1行=1 ChannelListing、独立 |
| 二重実行防止 | **lease**(`leaseOwner`/`leaseExpiresAt`、有効期限付き、ブラウザ手動advanceとLambda scheduleの両方が同じ行を共有するため必須) | **今回追加**: `status`のcompare-and-swap(`ConditionExpression: "#s = :pending"`でPENDING→PROCESSINGへの遷移を保護) | 既存: `nextPriceActionAt`のcompare-and-swap(`ConditionExpression: "nextPriceActionAt = :prevNpa"`) |
| リトライ/DLQ相当 | `retryCount`、上限到達で`status=FAILED`(ADMINが新規run開始) | `attemptCount`、3回到達で`status=DEAD_LETTER` | 個別行のエラーはログのみ(次回tickで`nextPriceActionAt`条件を再度満たせば自然に再試行、明示的なDLQ状態は無い——値下げという操作の性質上、1回飛ばしても実害が軽微なため) |
| heartbeat/生存確認 | `lastHeartbeatAt`(ページ処理毎に更新) | 無し(1行の処理は通常数秒〜十数秒で完結し、Lambda全体のtimeout(300秒)を跨ぐ心配が無いため不要と判断) | 無し(同上の理由) |
| checkpoint | `lastPage`/`seenSourceIds`/各種カウント、途中で止まっても続きから再開できる | 無し(1行=1回で完結する作業単位のため、途中再開という概念自体が無い) | 同左 |
| 1回の起動での処理上限 | 時間予算(`TIME_BUDGET_MS`)ベース——残り件数ではなく残り時間で打ち切る | 件数上限(`MAX_JOBS_PER_RUN=20`)——sharp処理のI/O負荷を保守的に抑える | 上限なし(BASE API呼び出しのみでI/O量が小さいため) |
| エラースキーマ | `lastError: string`(1個) | `errorCode`/`errorMessage`(2個、機械可読コードと人間向け文言を分離) | ログのみ(モデルにエラー専用フィールド無し) |

## 今回発見・修正した不整合(1件)

**ProcessingJobにPENDING→PROCESSINGの二重取得防止が無かった**
——スケジュールが5分毎で、かつ1回の実行が処理件数超過(sharp画像
処理はI/Oが重い)で5分を超えて長引いた場合、次のスケジュール実行が
同じPENDING行をもう一度Scanで拾い、同じ画像を2回加工してしまう
実害があった(ZaicoSyncJobは既にlease機構でこれを防いでいたが、
ProcessingJobには対応する仕組みが無かった)。

**修正**: `amplify/functions/image-processing-worker/handler.ts`に
`claimJob()`を追加——PENDINGであることを`ConditionExpression`で
確認してからPROCESSINGへ書き換える単純なcompare-and-swap
(pricing-schedulerの`nextPriceActionAt`条件と同じ考え方をstatusに
適用しただけ)。条件が満たせなければ`ConditionalCheckFailedException`
を捕まえ、二重処理せず静かにスキップする。ZaicoSyncJobのような
有効期限付きleaseにはしなかった——ProcessingJobは「1行=1回で完結する
独立した作業単位」であり、単一のsingleton行を複数tickにまたいで
共有するZaicoSyncJobとは性質が違うため、より単純な仕組みで十分と
判断した(不要な複雑化を避ける)。

`npm run synth:check`でLambdaが引き続き正しくbundleされること、
`npm run verify:image-processing`で既存36件のassertionに影響が
無いことを確認済み。

## 統一しなかった項目とその理由

- **heartbeat**: ZaicoSyncJobだけが持つ。他の2つは1回の作業単位が
  短時間で完結するため、「実行中だが応答が無い」を検知する必要性が
  薄い——無理に追加すると使われないフィールドが増えるだけ。
- **checkpoint**: 同上——ZaicoSyncJobだけが「複数tickにまたがる1つの
  大きな作業」という性質を持つ。
- **エラースキーマの統一(`lastError`単一 vs `errorCode`+`errorMessage`)**:
  ZaicoSyncJobを`errorCode`+`errorMessage`の2フィールドへ変更する
  ことも検討したが、既存のUI(`ZaicoSyncPanel.tsx`)・checkpoint書き込み
  ロジック双方への影響範囲が本ラウンドのP1-Cのスコープ(横断比較+
  抜けの補完)を超えるため見送った——将来ZaicoSyncJobのエラー表示を
  改善する際の候補としてここに記録する。
