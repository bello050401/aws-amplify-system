# ユーザー設計全体の対応表

2026-09-16更新。正本は添付「GPT + Claude Code 協調エコ開発モード」v1.0全20節と本タスクの追記・確定会話。後の指示を優先する。以下は範囲の縮小ではなく、完了判定の索引である。未検証と未接続は完了に数えない。

最新方針: 通常業務開発・旧キューは停止。協調エコ基盤全体の完成・実証・有効化が最優先。非破壊の追加schema導入は明示承認された。追加課金・本人認証回避・production操作の承認ではない。

|正本|実装・既存証拠|現時点の未完・要検証|
|---|---|---|
|§1 絶対条件 / AC01,12|isolated worktrees、旧DB/差分保全、evidence gate、承認binding、安全性試験|主DB追加migration前後の件数・pause照合、全常駐adapterの再点検|
|§2 成功測定|modelEvaluation、3件ずつのpilot記録（評価として不十分）|同程度の実開発による長期比較。節約率・耐久性を未測定で保証しない|
|§3 調査・保全|discovery/status/live-progress/completed-smoke記録|既存記録を再利用し、常駐接続変更の対象だけ更新|
|§4 役割 / AC05|既存Runner、独立Verifier、EcoEngine、spec/qa成果物、routedGptWorker、subscriptionTextWorker|常駐GPT実画面worker、入力最小化と例外読込、clarification仲介の実経路|
|§5 UI / AC02,03|4mode/8設定/version保存、API制約、未接続表示|主サービスのruntime注入、操作・成果物リンクとモデル/使用量表示、実画面の再読込・keyboard検証|
|§6 モデル / AC08|taskRouting、能力条件、階層、資格評価、usage区別、利用枠停止|両providerの実経路で仕事別切替、reasoning/選定理由、階層baselineと資格付き自動選択を区別して検証|
|§7 永続モデル|eco schemaと旧tasks/checkpoints/deploymentを再利用|必須論理項目の実経路充足、主DB追加導入|
|§8 成果物 / AC06|artifacts schema/version/evidence/AC検証、immutable保存|常駐登録・取得API、限定的な成果物修正（実装再試行と分離）、clarification期限処理|
|§9 状態/修正 / AC07,15|engine lease/CAS/journal、0/上限・容量・停止の合成試験|主サービス再起動で実worker照合、変更不要完了、production状態経路、停止中の外部結果保存|
|§10 読込 / AC09|EcoCache hash/依存/仕様/権限fingerprint、破損・変更試験|Runner入力への要約再利用、編集直前hash照合、読込bytes・再読込実測、進行中参照を保持するGC|
|§11 テスト / AC10|EcoCache test keyと失敗/flaky拒否、独立Verifier receipt|実Verifierの実行/reused区別・安全な選択・時間記録、外部状態不明時再実行|
|§12 画面 / AC04|専用static stagingでGPT desktop実画面QA成功|session依存を解消した常駐ブラウザworker、操作/reload/証拠/viewport/時間、保存操作対象での受入|
|§13 承認 / AC12,13|対象/digest/expiryの保存と偽装拒否、保護action分類|正規承認UI・権限確認・実行直前消費、本人認証復帰、影響/rollback表示|
|§14 配信 / AC11|専用Amplify実配信・HTTP/digest照合、環境lock|主サービス結線、許可profile、安全rollback、production承認付き別操作。業務staging隔離は未確立|
|§15 API|settings/control認証、version/idempotency|run開始/詳細/artifacts/events、担当範囲付き提出、承認/却下、実service接続|
|§16 互換 / AC17|コピーDBでmigration再実行・保全合格、flag OFF参照|主DB整合backup・追加導入・旧経路復帰実証。保存だけで再開させない|
|§17 監査 / AC16|run usage/state/repair/model routing checkpoint|全必須指標・unknown表示・モデル別時刻/時間/推定根拠、集計UI・保持期間|
|§18 試験|217件成功、PowerShell構文成功、専用実E2E成功を再利用|今回変更に必要な試験と常駐再起動を含む複数工程。長時間耐久は別途実測|
|§19 全18AC|本表と既存AC証拠の対応|全行が実装・必要検証済みになるまで全体完成とはしない|
|§20 納品 / AC18|既存成果・実E2E・業務タスク局所完了記録|主サービス有効化、全要件結果/未検証一覧、設定/rollback/再開地点を最新化|

## 会話由来の追加条件

- **元からの必須要件**: 重い実装・広範な調査・テスト修正は原則Claude Code担当。GPTは要件整理・作業分割・必要最小の差分レビュー・実画面QAを担当し、同じ重作業を重複実行しない。Claude利用枠不足をGPTへの重作業自動転送で回避しない。検証は担当モデル・実行経路・入力byte/読込範囲・使用量の記録で確認する。
- **元からの必須要件**: 無駄な読込を削減する。既存仕様・成果・調査・試験証拠を再利用し、変更箇所と不足だけ取得。全履歴・全コード・同一ログの不要な再読込をしない。必要な再読込には更新・依存変更・要約不足などの理由を記録し、実行経路でも検証する。
- GPTによる毎回のコード/diffレビューは標準工程にしない。通常は構造化成果物・独立検証・実画面で判断する。安全境界、受渡し契約、不合格原因など具体的必要性があるときだけ理由・対象・範囲を記録して例外読込する。Claudeとの重複読込を避ける。モデルだけでなく対応する思考設定も仕事別に選択し、非対応設定は送らない。
- 323件の対応事項: 通常画面は現進行を本当に止める対象だけ、重複統合・過去/完了/失効の履歴保持、AI処理と後で確認を区分。既存triage/UIと検証を再利用し、今回変更で後退させない。
- 指示確認後の役割分担・仕事分類・Codex/Claude両方のモデル振分け。評価不足の安価モデルを「同等品質」と断定しない。実開発の証拠を蓄積し、比較専用試験を濫発しない。
- 通常Git/再テスト/軽微修正/ログ/safe retry/stagingはAI側で進行。production等の指定境界と本人操作だけ必要事項をまとめて提示する。
- 実運用データ/ZAICO/LINE/Mercari/顧客認証情報を専用検証へ持ち込まない。既存環境の設定を変更しない。外部通知はユーザー指示で後回し。
- 未コミット原本は保全。通常開発task_c3e9d0b64572a9baeb・task_8be7018659fd7904a7はローカル工程完了、後続task_243f591b4b99a47ba1は最新優先指示によりpaused。

## 実測の扱い

専用static stagingの成功は業務アプリ全体の受入ではない。短いpilotはモデル同等性や節約率の証明ではない。型検査用のAWS接続なしoutputsは実AWS接続の証拠ではない。各未完を完成に読み替えない。

## ピン留め4タスク照合のU01〜U12

補助索引 `C:/Users/win/Documents/Codex/2026-09-16/new-chat-2/outputs/開発管理システム-完成条件と確認記録.md` を参照。既存担当が主設計全13ページを確認済みなので同じ履歴を再取得しない。

|ID|対応|実装・実証と未達|
|---|---|---|
|U01 一貫運用|§4/9/14/15, AC18|隔離static実E2E済。常駐runtime/APIを接続中。一般タスク受付から人間転記なしの実証は未達|
|U02 GPT実画面|§12, AC04/05|desktop実QA済。常駐browser workerをClaude実装中|
|U03 Claude重作業|§4, AC05|重実装はnativeClaude、GPTは仕様・必要な安全境界レビュー。標準でGPT重実装/二重コードレビューをしない|
|U04 両AIモデル/思考|§6, AC08|分類/能力/資格判定あり。実経路の段階選択・対応思考設定・切替証跡は未完|
|U05 両AI省読込|§10/17, AC09/16|cache関数/試験あり。Agent入力・読込broker・実測への結線は未完|
|U06 構造化仲介|§8/15, AC06|schema/revision/evidence検証あり。常駐APIと実workerを接続中|
|U07 枠/復帰|§6/9, AC07/13/15|容量待ち・予算・journalの合成検証済。実常駐再起動の証跡は未完|
|U08 本当のTODOのみ|会話TODO整理, AC12|既存triage/UI/履歴保全を再利用。eco停止理由の同じ分類への結線を要確認|
|U09 有効な再利用|§10/11, AC09/10|fingerprint/cache試験済。実Verifier/両Agent経路への接続は未完|
|U10 境界/二重処理|§9/13/14, AC12/15|承認binding/lease/journal。legacyとeco間の二重実行防止の追加修正中|
|U11 設定と実稼働|§5/18, AC04/11/17|主DBinstalled=true/enabled=false。接続・probe・実動作確認後にのみ有効化を判断|
|U12 全指示|§1〜20, AC01〜18, 本表|未達を列挙し全体完成とは扱わない。問い合わせ月300円予算と開発quotaを混同しない|

## 今回の例外読込・保全証拠

- 追加確認（2026-09-16）: 常駐runtime 20ケース、browser worker初稿22ケース、厳密origin/path境界5ケース、metrics 9ケース成功。キャッシュ統合初稿は9ケース中3失敗を検出し、Claude修正中。全体完成とは扱わない。
- 実ブラウザ: `bello-eco-worker-integration-20260916/real-browser-probe/receipt.json` に専用static環境の表示・再読込・前後撮影を記録。実Chromium起動とCodex既存認証probe成功。モデルによる最終QAの常駐一貫実行とは区別する。
- 実画面設定: `bello-eco-ui-runtime-20260916/real-ui-probe/receipt.json`。隔離DB上で保存HTTP200・再読込保持・JS例外0・認証token消去・localStorage保存なし・pause保持・enabled=falseを確認。
- GPT例外修正: runtimeのmode変更/事前validation不足とbrowserの同host別port/pathへの通信境界だけを限定修正。重実装の再担当ではなく、検出した安全境界の是正。追加回帰試験済み。

- `serviceRuntime.mjs`初稿: GPTがtask所有権・原子性・停止ゲートとAPI引数受渡しだけ確認。常駐接続という安全境界のレビューであり、通常業務の毎回レビューではない。
- 元仕様書: 最新ユーザーが完成条件を全設計へ明確化したため、正本全20節を1回再確認して本表を作成。以後は本表と原文の必要節のみ参照。
- 稼働DB追加schema: `C:/Users/win/Documents/Codex/bello-eco-service-integration-20260916/migration-verification.json`。整合backup、14旧テーブルhash/件数・旧meta・pause保持、再実行可能性を確認。flagは無効のまま。
