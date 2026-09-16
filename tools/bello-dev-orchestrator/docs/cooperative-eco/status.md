# 協調エコ開発モード：実装・検証記録

2026-09-16。**基盤実装・隔離検証の段階です。常駐Agentを使った実接続E2Eの完了ではありません。**

## 変更概要

- 4モードと必須8設定の画面／API、設定version・冪等キー・run別snapshotを追加。
- 既存Claude／Codexモードは既存の実装担当設定へ対応。保存はpauseや既存タスク状態を変更しない。
- 新しいDBテーブルは明示的な追加migrationのみ。既存起動処理で自動適用しない。
- 修正上限、別カウントの通信／成果物エラー、予算上限、pause/resume/cancel、lease、状態version照合を実装。
- 外部操作の意図を保存し、結果不明なら再送せず停止。stagingをデプロイからQA完了まで予約する。
- 仕様・実装・QA成果物の契約と証拠参照を検査。不正な成果物や別buildのQAでは完了できない。
- 内容hashを使う要約／テストキャッシュと論理モデル階層の選択関数を追加。
- 協調モードの書込みは専用operatorトークンを要求。Agent向け承認APIは公開しない。
- ブラウザQA、Claudeの認証・能力、協調run用staging接続は未接続表示。接続未確認での有効化を拒否する。

## 変更ファイルと再利用

- `src/eco/{policy,store,engine,artifacts,cache,api}.mjs`、`src/eco/schema.sql`
- 既存 `src/dashboard/server.mjs`、`public/index.html`、新規 `public/eco.js`
- `test/eco.test.mjs`、`test/manual/eco-{preview,migration-check,preservation-check}.mjs`

既存のStore・Repo・Dashboard・実装担当設定を利用。既存Runner、IndependentVerifier、AmplifyStaticDeliveryは変更していない。これらを協調engineへ接続する本番用アダプターは**未実装**であり、既に再利用できていると扱わない。二重の実行・AWSデプロイ実装は追加していない。

## 実行した試験

- 全体回帰：189 passed / 0 failed。
- 最終のlease所有確認・承認更新の原子化後：関連21 passed / 0 failed。
- PowerShell：Start-BelloOrchestrator.ps1構文検査成功（実行せず構文のみ）。
- ブラウザ：隔離DBのlocalhost:4327でモード変更、認証なし保存の失敗表示、認証後保存、再読込保持、cache OFFによる再読込抑制OFF、本番承認ON固定を確認。
- 合成E2E：QA発見→仕様→実装結果→独立テスト結果→staging結果→再QA→完了まで**stubアダプター**で通過。実Claude／GPT／AWSを呼んでいない。
- 実DBバックアップのコピーへmigrationを2回適用し、再読込後も167タスク、2383状態履歴、330TODOなど元の全業務テーブルの件数・内容hashと既存metaが一致。整合性検査ok。
- テスト結果の流用で今回の検査を省略していない。キャッシュの再利用は合成fixtureで検査しただけで、実運用の削減効果は未測定。

証跡：`C:/Users/win/Documents/Codex/bello-eco-preservation-20260916/`
`final-tests.log`、`eco-final-tests.log`、`migration-check.json`、`preservation-check.json`。

## 保全確認

主リポジトリは変更していない。既存未コミット `docs/health/final-tests.md` のSHA256は開始時と同じ：
`A9DD1EA3A5C3878F9AD6B0A3E7302398229CD57E3FDE554F7DDDCD88261A3CF0`。

稼働DBは読み取りと開始時の整合バックアップのみ。新しいecoテーブルは存在しない。主サービスを再起動／再開していない。

ただし作業中も主サービス側で状態が変化していた。比較時点では既存1タスクがqueuedからfailedへ進み、履歴が7件、TODOが1件増え、pause値も1から0へ変わっていた。過去2383件の履歴自体は不変。これらを開始時の値に巻き戻していない。したがって「稼働DBが開始時と完全一致」とは報告しない。

## AC別の現在地

| AC | 判定と証拠／残作業 |
|---|---|
| 01 保全 | 隔離migrationと保存時pause保全は合格。実DBは他の稼働による更新あり、今回の適用なし |
| 02 モードUI | 保存・再読込、旧provider対応は合格。協調／全自動の常駐実行は未接続 |
| 03 設定制約 | ローカル合格。8設定、0〜10回、承認OFF拒否、依存設定を検査 |
| 04 ブラウザ実利用 | 未完。設定画面の実ブラウザ確認は実施したが、常駐GPTのstaging QAではない |
| 05 役割分担 | 未完。GPT／Claude本番アダプターと入力の絞込みが必要 |
| 06 成果物仲介 | 単体合格。不正schema／revision／証拠／AC不足を拒否。本番提出API未接続 |
| 07 修正ループ | 単体・合成結合合格。0回／2回上限、初回の除外、永続回数を検査 |
| 08 モデル制御 | 方針関数のみ合格。実モデル可用性・認証・能力照合とRunner接続が必要 |
| 09 読込再利用 | キャッシュ単体合格。Agentの実読込への接続・読込量計測は未完 |
| 10 テスト再利用 | 単体合格。SHA／未コミット内容／依存／環境差、失敗・flaky、証拠変更を検査。Verifierへの組込みは未完 |
| 11 staging | 合成結合合格。既存配信アダプターへの接続、実health／revision照合・rollbackは未完 |
| 12 承認境界 | 保存層とAPI拒否試験は合格。独立安全判定は未接続なら拒否。認可された承認UIと実行直前の消費連携は未完 |
| 13 本人操作 | auth/capacityの別状態は単体合格。実ログイン復旧は未検証 |
| 14 完了判定 | 合成結合合格。BLOCKED／NOT_RUN・別buildは完了不可 |
| 15 復旧 | 単体合格。二重worker、失われた応答の照合、再送禁止。実外部jobの復旧は未接続 |
| 16 監査 | 状態イベント・回数・usage既知／不明の保存のみ。要求された全メトリクス／可視化は未完 |
| 17 migration | コピー上で保全・再実行・再読込合格。feature flag OFFでも参照可能。本番未適用 |
| 18 自律継続 | 未完。協調worker・本番アダプター・実QAを常駐経路に接続してから通し検証が必要 |

## 設定／試験の再開方法

隔離worktree `C:/Users/win/Documents/Codex/bello-cooperative-eco` の `tools/bello-dev-orchestrator` で：

```powershell
node --test test/eco.test.mjs
node test/manual/eco-preview.mjs
```

previewは使い捨ての空DBとloopbackポート4327を使う。Agent／AWS／主サービスのworkerを開始しない。画面試験専用tokenは `synthetic-preview-only`。本運用で使用してはいけない。

`EcoApi`の本番書込みは`BELLO_ECO_OPERATOR_TOKEN`と適用済みeco schemaを必要とする。通常のAgent子プロセスにはこのtokenを渡さない。現時点では主サービスへ設定・有効化しない。

## 残作業と次の実装順

1. 常駐GPTのブラウザQA実行手段を接続する。対話中のCodexブラウザ機能は、常駐Nodeプロセスから使えるアダプターではない。認証済みQAセッション／許可ドメイン／モデル能力を実際に確認する必要がある。
2. 既存ClaudeRunner・IndependentVerifier・staging配信へ接続。旧キューとのタスク所有権調停、実行時間制限、予算の事前予約、実モデル能力照合、成果物の権限別APIを完成させる。
3. モデル選択・要約キャッシュ・テスト再利用を実際のAgent／Verifier経路に組み込み、全メトリクス、承認UI、安全判定／rollbackを完成させる。
4. 専用検証環境で実接続E2E。mockの合格をこの合格へ流用しない。
5. 全部の適用内容を再点検後、指示書§16に従って稼働DB migrationの明示承認を受ける。現段階での稼働適用は推奨しない。

## rollback

現在は隔離worktreeだけなので主サービスにrollback操作は不要。将来適用時はworkerを停止しfeature flagをOFFにして旧コードへ戻す。追加テーブル・履歴を削除するdown migrationは行わない。既存データを古いバックアップで上書きしない。

本番deploy、本番データ変更、AWSリソース変更、外部送信、追加API課金は今回行っていない。
