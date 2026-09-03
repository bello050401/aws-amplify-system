# アーキテクチャ

## 1. コンポーネント

| # | コンポーネント | 実装 | 役割 |
|---|---|---|---|
| 1 | Supervisor | `Start-BelloOrchestrator.ps1` + Scheduled Task | Windows 起動、単一起動、子プロセス監視、異常終了時の再起動 |
| 2 | Orchestrator | `src/core/orchestrator.mjs` | 状態遷移、キュー制御、依存関係、再試行、承認境界、停止/再開 |
| 3 | Claude Runner | `src/runner/claudeRunner.mjs` | Claude Code CLI の安全な起動、構造化完了報告の取得 |
| 4 | Review Engine | `src/review/openaiReview.mjs` + `evidenceGate.mjs` | 完了報告の審査。証拠ゲートが AI より強い |
| 5 | User TODO Manager | `src/todo/todoManager.mjs` | 本人操作の分離、完了検証、依存タスクの再開 |
| 6 | Document Intake | `src/intake/` | .docx の安全な取込、抽出、重複排除、タスク化 |
| 7 | Local Dashboard | `src/dashboard/` | 進捗・TODO・ログ・停止再開。既定 localhost 限定 |
| 8 | Persistent Store | `src/store/` (node:sqlite) | プロセス終了・PC 再起動をまたいで状態を保つ |
| 9 | Audit Log | `audit_log` テーブル | 誰が・いつ・何を登録/判断/実行/承認したか |
| 10 | Installer / Diagnostics | `bello.ps1` + `src/diagnostics.mjs` | 一回のセットアップ、自己診断、修復、解除 |

Remote Control (`tools/windows-claude-host`) は**補助経路**であり、このシステムのタスク永続化には使いません。
Remote Control が切れても、キューとタスク状態は SQLite に残ります。

## 2. プロセス構成

```
Scheduled Task \BELLO\BelloDevOrchestrator
  └─ powershell.exe  Start-BelloOrchestrator.ps1 -Watchdog     ← 監督プロセス (Mutex: Local\BELLO-DevOrchestrator)
       └─ node.exe   src/cli.mjs start --watchdog              ← Orchestrator (PID ファイル: state/orchestrator.pid)
            ├─ node:http ダッシュボード (127.0.0.1:4319)
            └─ claude.exe -p --output-format json ...          ← タスクごとに起動
                 └─ (Claude Code が起動する子プロセス群)
```

単一起動は二重に守られます。

1. Scheduled Task の `MultipleInstancesPolicy = IgnoreNew`（実測: イベント ID 322 で確認）
2. 監督プロセスの名前付き Mutex `Local\BELLO-DevOrchestrator`
3. Orchestrator 自身の PID ファイル。PID 再利用を誤認しないよう、プロセス名が `node` であることも確認します。

監督プロセスだけが強制終了された場合、生き残った Orchestrator を**引き継ぎます**（殺して作り直しません）。
実行中の Claude タスクは 1 時間かかることもあり、捨てる損害の方が大きいためです。

## 3. データモデル

`src/store/schema.sql` に定義。時刻はすべて UTC の ISO8601 で保存し、表示時に `Asia/Tokyo` へ変換します。

| テーブル | 内容 |
|---|---|
| `tasks` | 開発タスク。冪等性キーに UNIQUE 制約があり、同じ指示は二重登録されません |
| `task_state_history` | すべての状態遷移（誰が・なぜ） |
| `reports` | Claude の構造化完了報告（秘密除去済み） |
| `reviews` | 審査結果、モデル名、プロンプト版、使用量 |
| `todos` | ユーザー TODO。`dedupe_key` の部分 UNIQUE 索引で同じ依頼を繰り返しません |
| `documents` | 取り込んだ Word。SHA-256 に UNIQUE 制約 |
| `checkpoints` | 工程ごとのチェックポイント（復旧用） |
| `audit_log` | 監査ログ |
| `idempotency` | 外部操作の二重実行防止キー |

## 4. 状態遷移

`src/core/states.mjs` の遷移表がすべてです。`repo.setState()` は必ず `assertTransition()` を通るため、
任意の状態書き換えで矛盾は作れません。

```
queued ──► preflight ──► running ──► verifying ──► awaiting_ai_review ──► completed
   ▲          │             │            │                │
   │          │             │            │                ├─► revision_required ──► queued
   │          │             │            │                ├─► awaiting_user
   │          │             │            │                ├─► paused
   │          ▼             ▼            ▼                └─► failed
   │       retry_wait ◄─────┴────────────┘
   │          │
   └──────────┘   (バックオフ経過後)

awaiting_user ──(TODO 完了)──► queued
failed / cancelled ──(ダッシュボードの明示操作)──► queued
completed ──► (終端。ここからは戻りません)
```

## 5. 1 タスクの流れ

1. **preflight** — git 作業ツリーを確認し、開始時点のスナップショット（dirty なファイル一覧、HEAD）を保存。
2. **running** — `claude -p --output-format json --json-schema <完了報告スキーマ>` を起動。
   指示本文は**コマンドライン引数ではなく標準入力**で渡します。stdout / stderr は時刻付きの別ファイルへ。
3. **verifying** — 証拠ゲート。テスト結果・exit code・変更ファイルの実在・Git の HEAD 変化・保護ブランチを突合。
   合格していれば、作業開始前から dirty だったファイルを**除いて**自動コミット。
4. **awaiting_ai_review** — OpenAI に構造化審査を依頼。API キーが無ければここで待機し、TODO を出します。
5. 審査結果に応じて completed / revision_required / awaiting_user / paused / failed へ。
   **証拠ゲートが落ちていれば、AI が accept でも accept にしません。**

## 6. 暴走防止

| 仕掛け | 場所 | 効果 |
|---|---|---|
| 証拠ゲート | `evidenceGate.mjs` | AI の文章ではなく事実で判定 |
| 自動修正の上限 | `review.maxRevisions`（既定 3） | 修正ループの回数上限 |
| 同一失敗の検知 | `last_failure_signature` | 同じ理由が続いたら上限前でも停止 |
| 再試行上限 | `queue.maxAttempts`（既定 3） | 異常終了の繰り返しを止める |
| 指数バックオフ | Orchestrator / 監督プロセス / OpenAI 呼び出し | 連打しない |
| crash-loop 停止 | 監督プロセス（10 分に 5 回） | 無限再起動を止め、30 分クールダウン |
| 低確信度の保留 | `review.minConfidenceToAccept` | 自信が無い合格を人へ回す |
| 予算上限 | `claude.maxBudgetUsd` | 1 タスクの API 費用に上限 |

## 7. 秘密情報の流れ

```
環境変数 ──► 起動時に registerEnvSecrets() で「除去対象」に登録
             │
             ├─► OpenAI 呼び出し (Authorization ヘッダのみ。本文には入れない)
             │
ログ / 監査 / 完了報告 / API 応答 / 審査への入力
             └─► すべて redactText() / redactValue() を通過
```

`.env`、`*.key`、`*.pem`、DB、ログ、inbox 文書は自動コミットの対象から除外します。
