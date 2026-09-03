# テスト結果と既知の制約

測定日: 2026-09-03
環境: DESKTOP-91TNKS2 / Windows 10 Home 10.0.19045 / Windows PowerShell 5.1.19041.6456 /
Node.js v24.20.0 / npm 11.19.0 / git 2.55.0 / Claude Code 2.1.259

---

## 1. 自動テスト

```
node --test "test/*.test.mjs"
→ tests 58 / pass 58 / fail 0   (約 9.7 秒)
   内訳: unit 34 件、integration 24 件
```

実 Claude・実 OpenAI は呼びません。`FakeClaudeRunner` と `FakeReviewEngine` を使います。

### 単体テスト (34 件) が守っていること

| 対象 | 検証内容 |
|---|---|
| 状態遷移 | 許可された遷移だけ通る / 同じ状態への遷移を拒否 / 終端から戻らない / 未知の状態を拒否 |
| 完了報告スキーマ | 必須項目、enum、未知プロパティの拒否 |
| 審査結果スキーマ | decision の enum、confidence が 0..1 |
| 設定検証 | permissionMode、maxRevisions、無認証 LAN 公開の拒否、allowedTools 空の警告 |
| 秘密情報の除去 | Bearer / sk- / AWS キー / GitHub トークン / JWT / Cookie / URL クエリ / 登録実値 / 循環参照 / **真偽値は残す** |
| ログ | サイズ超過で回転し、保持世代を超えない |
| 証拠ゲート | テスト未実行・テスト失敗・非 0 終了・HEAD 不変での commitCreated=true・保護ブランチを不合格にする |
| ファイル名 | パストラバーサル除去、通常の名前を壊さない、`~$` 一時ファイルの除外 |
| docx 抽出 | 見出し / 箇条書き / 表、XML エンティティ、画像とマクロの警告、document.xml 欠如と壊れた zip の明示的失敗 |
| 冪等性 | 同じ指示は二重登録しない、冪等性キーは一度だけ |
| TODO | 必須回答が空なら完了させない、同じ依頼を繰り返さない、依存解除は一度だけ、満たされている環境要件は要求しない |
| 再試行 | retry_wait は時刻が来るまで戻らない |
| 依存関係 | 未解決の依存があるタスクは優先度が高くても選ばない |
| Claude Runner | 引数の組み立て（許可リスト / 拒否リスト / resume） |

### 統合テスト (24 件) — 指示書 §14-2 の 10 シナリオ + 追加

| # | シナリオ | 結果 |
|---|---|---|
| 1 | 登録 → Claude 成功 → 審査合格 → 完了（状態履歴も検証） | pass |
| 2 | 部分完了 → 修正指示 → 再実行 → 完了（修正指示が次の指示に載る） | pass |
| 3 | 本人操作検出 → TODO 生成 → 完了チェック → 再開 | pass |
| 4 | Word 投入 → 安定待ち → 抽出 → タスク生成 → processed 移動 | pass |
| 5 | 同一 Word 再投入 → 重複排除 | pass |
| 5b | 書き込み途中・Office 一時ファイルを掴まない | pass |
| 6 | Claude 異常終了 → 再試行 → 上限で失敗 + TODO | pass |
| 6b | 同じ失敗の連続 → 上限前に停止 | pass |
| 6c | スキーマ違反の報告は審査へ送らない | pass |
| 7 | Orchestrator 強制終了 → 再起動 → 状態復旧 | pass |
| 7b | 再試行上限に達したまま中断 → ユーザー待ち | pass |
| 7c | **審査待ちは復旧で作り直さない**（成功した Claude 実行を捨てない） | pass |
| 7d | 検証中に中断 + 完了報告あり → 審査から再開 | pass |
| 7e | 検証中に中断 + 完了報告なし → 再実行 | pass |
| 8 | 審査 API 障害 → バックオフ → 復旧後に流れる | pass |
| 8b | API キー未設定でも止まらず TODO を出す | pass |
| 9 | 自動修正の無限ループを止めて TODO | pass |
| 9b | **証拠ゲートが落ちれば AI の accept を採用しない** | pass |
| 9c | 低確信度はレビュー待ち | pass |
| 10 | dirty worktree のユーザー変更を自動コミットに巻き込まない | pass |
| 10b | 保護ブランチでは自動コミットしない | pass |
| 10c | `.env` / DB をコミット対象に含めない | pass |
| — | 審査不能時にループが空転しない | pass |
| — | 一時停止中はタスクを開始しない | pass |

---

## 2. ダッシュボードのセキュリティ試験 (12 件すべて合格)

稼働中のサーバへ実際に HTTP を投げて確認します。

```
node test/manual/dashboard-security.mjs
→ 合格 12 / 不合格 0
```

| 検証 | 結果 |
|---|---|
| GET /api/home が 200 | OK |
| CSRF: `X-BELLO-Request` 無しの POST を 403 で拒否 | OK |
| CSRF: 異なる Origin の POST を 403 で拒否 | OK |
| XSS: `<script>` を含むタスクを登録でき、応答は JSON で HTML ではない | OK |
| アップロード: `.docx` 以外を拒否 | OK |
| アップロード: パストラバーサル名でも 5xx にならない | OK |
| 静的配信: 許可リスト外は取得できない | OK |
| TODO: 必須回答が空なら 400 で拒否 | OK |
| 設定 API に API キーの値が含まれない | OK |
| システム API は `apiKeyConfigured` の真偽だけを返す | OK |

---

## 3. Windows 実機での復旧試験

### 3.1 Orchestrator (`\BELLO\BelloDevOrchestrator`)

| 障害 | 実測復旧時間 | 同時インスタンス数 |
|---|---|---|
| Orchestrator (node) を強制終了 | **6 秒** | 常に 1 |
| 監督プロセスだけを強制終了（node は孤児化） | **48 秒**。生き残った Orchestrator を引き継ぎ、作業を失わない | 常に 1 |
| 監督プロセスのコンソールを破壊 | **停止しなかった**（Orchestrator はコンソールに依存しない） | 常に 1 |
| 監督プロセスと node を同時に強制終了 | **21 秒** | 常に 1 |

多重起動抑止は Task Scheduler の**イベント ID 322**（同じタスクのインスタンスが実行中のため起動しなかった）で実測確認しました。

状態復旧の実測:

```
task_366e49a34658b2d3d2  running -> awaiting_user  [recovery]
  Orchestrator の異常終了から復旧: 直前の状態 running / 再試行上限に到達
  checkpoint: recovery / audit: task.recovered / TODO: 「中断したタスクの扱いを決めてください」
```

### 3.2 Remote Control (`\BELLO\ClaudeCodeRemoteControl`)

本日、オフラインの原因調査と修正も行いました（`tools/windows-claude-host`）。

| 障害 | 実測復旧時間 |
|---|---|
| Remote Control 子プロセスを強制終了 | **6 秒**（監督ループの 5 秒バックオフ） |
| 監督プロセスを強制終了（孤児回収あり） | **25 秒** |
| コンソールを破壊 | **46 秒**（コンソール喪失を検知して退場 → ウォッチドッグが再起動） |

---

## 4. 実 Claude での End-to-End 実行（モックではありません）

タスク: 「tools/bello-dev-orchestrator のテストスイートを実行して結果を報告する（読み取りのみ）」

### 1 回目 — 既定設定の欠陥を発見

```
session dd6eeca9-f540-4991-9e85-547f5fd5da04 / exit 0 / 45.1 秒 / $0.171
status: blocked
commandsRun: git branch --show-current (exit -1), node --test (exit -1), ...
証拠ゲート: passed=false
  - status が completed である: status=blocked
  - テストがすべて成功している: passed が 0 件です (skipped のみ)
  - 実行コマンドがすべて成功している: 非 0 終了 3 件
```

`--permission-mode acceptEdits --permission-prompts none` では Bash が
「承認できる主体が居ない」として**自動拒否**され、テストが 1 つも走りませんでした。
Claude はそれを `userActions` として報告し、TODO「承認可能なセッションでテストを再実行する」が
自動生成されました。**証拠ゲートが正しく不合格にした**ことが確認できます。

### 2 回目 — 許可リスト方式に直した後

```
session 40300da8-180c-4bb6-8b4e-43be881938b9 / exit 0 / 32.7 秒
status: completed
commandsRun:
  git branch --show-current                              exit 0
  cd tools/bello-dev-orchestrator && node --test "test/*.test.mjs"   exit 0
tests: [{ name: "node --test tools/bello-dev-orchestrator", result: "passed" }]
changes: []   git.commitCreated: false
証拠ゲート: passed=true, failures=[]
→ awaiting_ai_review （OPENAI_API_KEY 未設定のため待機）
```

**実サービスでの確認事項**（モックではありません）:

- 実 Claude Code CLI が構造化完了報告を返す
- 完了報告がスキーマ検証を通る
- 証拠ゲートが 1 回目を落とし、2 回目を通す
- `userActions` が実際のユーザー TODO になる
- API キー未設定時に `awaiting_ai_review` で保持され、システムは止まらない
- 指示どおりファイルを変更せず、コミットもしなかった

**モックでのみ確認した事項**: OpenAI 審査の accept / revision / user_action / pause / fail の全分岐。
実 API キーが未設定のため、実 OpenAI 接続は未検証です（下記「既知の制約」）。

### 権限モードの実測（推測ではなく計測）

同じプロンプト（Bash で `node -e "console.log(42)"` を実行させる）で比較しました。

| 設定 | 結果 | 拒否件数 |
|---|---|---|
| `acceptEdits` + `--permission-prompts none` | 拒否 | 1 |
| `auto` + `--permission-prompts none` | 拒否 | 1 |
| `dontAsk` + `--permission-prompts none` | 拒否 | 1 |
| `acceptEdits` + `--allowedTools Bash` | **成功** | 0 |
| `acceptEdits` + `--allowedTools 'Bash(node:*)'` | **成功** | 0 |
| `bypassPermissions` | 成功 | 0 |

採用: `acceptEdits` + パターン付き許可リスト。`bypassPermissions` は指示書 §12 に反するため採らない。

---

## 5. リポジトリ全体の品質ゲート

| コマンド | 結果 |
|---|---|
| `npm run lint` | ✔ No ESLint warnings or errors |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0（全ルートの生成に成功） |

いずれも本作業の変更を入れた状態での実行結果です。本作業は `tools/` 配下のみを変更しており、
`app/` `lib/` `amplify/` には触れていません。

---

## 6. 既知の制約

| # | 制約 | 影響 | 対応 |
|---|---|---|---|
| 1 | **実 OpenAI API は未検証** | 審査の実接続は未確認。全分岐はモックで検証済み | `OPENAI_API_KEY` を設定すると有効になる。ユーザー TODO を生成済み |
| 2 | **PC 再起動後の自動復帰は未検証** | ログオントリガの実発火は実際にログオンしないと確認できない | ユーザー TODO 化（`docs/RECOVERY.md` §5） |
| 3 | 誰もログオンしていない状態では起動しない | PC 再起動後、サインインするまで動かない | 対話ログオン方式でパスワードを保存しないための意図的な仕様 |
| 4 | 画像内の文字を読まない | 画像だけに要件がある Word は取りこぼす | 画像がある文書では警告を出し、ユーザーに確認を促す |
| 5 | `.doc`（旧形式）に非対応 | 旧形式の投入は error へ | 明確なメッセージで `.docx` 保存を案内 |
| 6 | ZIP64 形式の .docx に非対応 | 極端に大きい文書は取り込めない | 明示的にエラーを出す（黙って空にしない） |
| 7 | 許可リストは対象リポジトリ向けの既定値 | 別のコマンドが必要なタスクは拒否される | `claude.allowedTools` に追記する。拒否は完了報告に残るので気づける |
| 8 | Claude セッションの再開は行わない | 中断したタスクは新しいセッションでやり直す | 同じ外部操作の二重実行を避けるための意図的な仕様 |
| 9 | ダッシュボードに認証が無い（localhost 時） | 同一 PC の他ユーザーからは見える | LAN 公開時のみトークン必須。既定は localhost 限定 |

---

## 7. 本作業中に実際に見つけて直した不具合

すべて実測から見つかったもので、推測ではありません。

| # | 不具合 | 見つけ方 | 対応 |
|---|---|---|---|
| 1 | Remote Control が再ログオンまで復旧しない | 09-03 のオフライン調査 | 1 分ウォッチドッグを追加 |
| 2 | supervisor だけ落ちると Remote Control が孤児化し二重ホストになる | 復旧試験B | 起動時に孤児を回収 |
| 3 | コンソール喪失時に子が即死し、再起動予算を浪費 | 復旧試験C | コンソール喪失を検知して exit 6 |
| 4 | `state.json` が異常終了後も `running` のまま | 調査時に発見 | ハートビート + 起動時修正 |
| 5 | 真偽値まで redaction され診断が読めない | API セキュリティ試験 | 文字列のみ落とすよう修正 |
| 6 | 審査不能時にループが空転（毎秒 8 回、ダッシュボード応答不能、2 回クラッシュ） | 実 E2E | `retry_after` で間隔を空ける |
| 7 | 既定の権限設定では Bash が動かずテストもビルドも走らない | 実 E2E | 許可リスト方式（実測で決定） |
| 8 | 復旧が審査待ちのタスクまで巻き戻し、成功した Claude 実行を捨てる | 実 E2E | 審査待ちは作り直さない |
| 9 | `bello.ps1 start` が停止フラグを解除せず何も起きない | 実機操作 | `resume` を追加して start/restart から呼ぶ |
| 10 | `bello.ps1` の出力が関数戻り値に飲まれて画面に出ない | 実機操作 | `Out-Host` を通す |
| 11 | 日本語を含む `.ps1` が Shift-JIS 解釈で構文エラー | 実機実行 | UTF-8 BOM + `.gitattributes` |
