# BELLO Claude Code 自律開発管理システム

開発指示をキューに積むと、Claude Code が調査・実装・テストを行い、OpenAI が完了報告を審査し、
本人にしかできない操作だけがユーザー TODO として残る ——— その循環を Windows 上で常駐させる仕組みです。

対象リポジトリ: `C:\Users\win\Documents\GitHub\aws-amplify-system`
本体 (`app/`, `lib/`, `amplify/` など) には一切手を入れません。独立したツールとして `tools/` に置いています。

---

## 1. これは何をするものか

```
  ┌── Word 文書 / ダッシュボード入力 ──┐
  │                                    ▼
  │                            [ タスクキュー ]
  │                                    │
  │                                    ▼
  │                       [ Claude Runner ] claude -p --json-schema
  │                                    │  構造化完了報告
  │                                    ▼
  │                       [ 証拠ゲート ] テスト結果 / exit code / Git 差分を機械的に突合
  │                                    │
  │                                    ▼
  │                    [ OpenAI 審査 ] accept / revision / user_action / pause / fail
  │                          │                 │
  │                          │                 └─→ [ ユーザーTODO ] 本人操作だけ
  │                          │                            │ 完了
  └──────────────────────────┴────────────────────────────┘ 依存タスクを一度だけ再開
```

**AI が「完了しました」と書いただけでは合格になりません。** 証拠ゲート (`src/review/evidenceGate.mjs`) が
テスト結果・コマンドの終了コード・Git の実際の差分を突合し、そこで落ちれば AI の accept を採用しません。

---

## 2. 5 分で始める

```powershell
cd "C:\Users\win\Documents\GitHub\aws-amplify-system\tools\bello-dev-orchestrator"
powershell -ExecutionPolicy Bypass -File .\bello.ps1 install
powershell -ExecutionPolicy Bypass -File .\bello.ps1 status
```

`install` が行うこと:

1. Node.js 22.5 以降と設定ファイルの確認
2. 実行時データ用フォルダの作成と設定検証
3. Scheduled Task `\BELLO\BelloDevOrchestrator` の登録（管理者権限は不要）
4. 即時起動

**成功の判定**: `status` に `プロセス: 稼働中 (pid …)` と出て、ブラウザで
<http://127.0.0.1:4319/> が開けること。

既存の `\BELLO\ClaudeCodeRemoteControl`（Remote Control ホスト）とは別タスクです。互いに干渉しません。

---

## 3. 日常の使い方

| やりたいこと | 操作 |
|---|---|
| 開発指示を出す | ダッシュボードのホーム「新しい開発指示を登録」 |
| Word で要望を出す | ダッシュボードの「レビュー文書」からアップロード、または inbox フォルダに `.docx` を置く |
| いま何をしているか見る | ダッシュボードのホーム / `bello.ps1 status` |
| 自分がやるべきことを見る | ダッシュボード最上部の「今、ユーザー様が行う必要があること」 |
| 一時停止 / 再開 | ダッシュボードのホーム、またはタスクの停止ボタン |
| 止める | `bello.ps1 stop`（実行中の Claude タスクの終了を待ちます） |
| 調子を見る | `bello.ps1 diagnose` |

inbox フォルダの場所はダッシュボードの「設定」画面に表示されます（既定
`%LOCALAPPDATA%\BELLO\dev-orchestrator\inbox`）。

---

## 4. ファイル構成

| パス | 役割 |
|---|---|
| `bello.ps1` | 運用コマンド入口 (install/start/stop/restart/status/diagnose/repair/uninstall) |
| `Start-BelloOrchestrator.ps1` | 監督プロセス。落ちたら再起動、crash-loop 停止、スリープ抑止 |
| `bello-orchestrator.config.json` | 非秘密の設定。**認証情報は絶対に書かない** |
| `src/cli.mjs` | Node 側の入口 |
| `src/app.mjs` | 単一起動・復旧・ループ・inbox 監視・ダッシュボードの組み立て |
| `src/core/` | 状態機械 / Orchestrator / Git 安全策 / スキーマ検証 |
| `src/runner/` | Claude Runner と完了報告スキーマ、テスト用 fake |
| `src/review/` | OpenAI 審査、審査スキーマ、証拠ゲート、テスト用 fake |
| `src/todo/` | ユーザー TODO |
| `src/intake/` | Word 取込 (最小 ZIP リーダー + docx 抽出 + 監視) |
| `src/dashboard/` | ローカルダッシュボード (node:http + 素の HTML/CSS/JS) |
| `src/store/` | 永続ストア (node:sqlite) |
| `src/log/` | ログとローテーション、秘密情報の除去 |
| `test/` | 単体 33 件 + 統合 19 件 |
| `docs/` | 設計・運用・復旧・安全境界の文書 |

**実行時データ** (DB / ログ / inbox / 取込済み文書) は `%LOCALAPPDATA%\BELLO\dev-orchestrator\` に置き、
Git 管理外です。リポジトリには入りません。

---

## 5. 秘密情報の扱い

- 設定ファイルにキーを書きません。**環境変数のみ**です。
- `OPENAI_API_KEY` … AI 審査に使います。未設定でもシステムは動き、審査待ちとユーザー TODO になります。
- `OPENAI_MODEL` … 省略可。
- `BELLO_DASHBOARD_TOKEN` … LAN 公開を有効にする場合のみ必須。
- ログ・API 応答・完了報告・審査への送信内容は、すべて `src/log/redact.mjs` を通します。
- ダッシュボードは秘密値を表示しません。「設定済みかどうか」だけを出します。

設定方法:

```powershell
[Environment]::SetEnvironmentVariable('OPENAI_API_KEY','<キー>','User')
# 設定後、Orchestrator を再起動する
powershell -ExecutionPolicy Bypass -File .\bello.ps1 restart
```

---

## 6. 自動でやること / やらないこと

**自動でやる**: 読み取り調査、既存コード検索、ローカル実装、テスト、ビルド、lint、型チェック、
文書更新、作業ブランチでのコミット、設定診断。

**自動でやらない**（ユーザー TODO になります）: 本番データの削除・大量更新、本番 DB の不可逆マイグレーション、
本番デプロイ・公開、保護ブランチへの自動マージ、課金サービスの有効化、OAuth / MFA / CAPTCHA / 本人確認、
認証情報の生成・変更・表示、IAM 等の権限拡大、外部ユーザーへのメッセージ送信、根拠のない仕様変更。

詳細は [docs/SECURITY-BOUNDARIES.md](docs/SECURITY-BOUNDARIES.md)。

---

## 7. 文書

| 文書 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 構成、データモデル、状態遷移、プロセス管理 |
| [docs/ADR-0001-technology-choices.md](docs/ADR-0001-technology-choices.md) | 技術選定と実測根拠 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | セットアップ、日常運用、TODO の処理、Word 投入、ログの見方 |
| [docs/RECOVERY.md](docs/RECOVERY.md) | 障害復旧手順と実測した復旧時間 |
| [docs/SECURITY-BOUNDARIES.md](docs/SECURITY-BOUNDARIES.md) | 安全境界、秘密情報、自動化しない操作 |
| [docs/TEST-RESULTS.md](docs/TEST-RESULTS.md) | テスト結果と既知の制約 |

---

## 8. 常駐をやめる

```powershell
powershell -ExecutionPolicy Bypass -File .\bello.ps1 uninstall
```

Scheduled Task の登録だけを解除します。プログラム本体、DB、ログ、取込済み文書は削除しません。
実行時データも消す場合は `%LOCALAPPDATA%\BELLO\dev-orchestrator` を手動で削除してください。
`\BELLO\ClaudeCodeRemoteControl` には触れません。
