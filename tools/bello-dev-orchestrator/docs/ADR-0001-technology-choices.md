# ADR-0001 BELLO 自律開発管理システムの技術選定

- 状態: 採択
- 日付: 2026-09-03
- 対象: `tools/bello-dev-orchestrator/`

指示書 §4 の順序（実測 → 既存規約 → CLI 実挙動 → PowerShell 5.1 安定性 → 依存最小化 → 永続化 → 秘密分離 → 独立 UI）に従って決めた。
断定ではなく、下記「実測」欄がすべて本 PC 上の実行結果である。

---

## 1. ランタイムと package manager

**決定: Node.js v24.20.0 / npm（既存 `package-lock.json` に合わせる）**

実測:

```
node v24.20.0
npm 11.19.0
pnpm not installed
package-lock.json あり / pnpm-lock.yaml・yarn.lock なし
```

pnpm は未導入のため採用しない。既存リポジトリは npm。

## 2. 永続化

**決定: Node 標準 `node:sqlite`（追加依存ゼロ）**

理由:

- 指示書 §4-6 は「トランザクション・一意制約・再起動耐性が必要。利用可能なら SQLite を優先」。
- `better-sqlite3` はネイティブビルドが必要で、Windows では node-gyp / Build Tools 依存になる。指示書 §4-5「ネイティブビルド必須パッケージは採用前に実機インストールを確認する」に対し、**確認コストと将来の破損リスクを避ける**判断。
- Node 24 には `node:sqlite` が同梱され、同期 API・トランザクション・UNIQUE 制約・WAL をすべて満たす。実測で `DatabaseSync` の UNIQUE 制約とトランザクション (ROLLBACK) が期待どおり動くことを確認した。起動時にも `probeSqlite()` が実行時検証を行う。

トレードオフ: `node:sqlite` は Node のバージョンに依存する。`src/store/db.mjs` が起動時にバージョンと API 可用性を検査し、満たさない場合は**診断モードで安全に起動失敗**する（指示書 §13-1）。

## 3. 追加 npm 依存

**決定: 実行時依存ゼロ。Node 標準ライブラリのみ。**

- HTTP サーバ: `node:http`（Express を入れない）
- テスト: `node:test` + `node:assert`
- .docx 解析: `node:zlib` の `inflateRawSync` による最小 ZIP リーダーを自前実装（`src/intake/docxReader.mjs`）
  - `mammoth` / `adm-zip` を入れない理由: docx から必要なのは `word/document.xml` ほか数エントリのみで、ZIP の Local File Header と End of Central Directory を読む数十行で足りる。依存追加による供給網リスクとインストール失敗リスクを避ける。
  - トレードオフ: 画像の OCR は行わない。画像・埋込オブジェクトは**存在フラグのみ**を抽出し、指示書 §9-3 に従って「画像だけに指示がある可能性」を UI に出す。

これにより `npm install` の失敗が本システムの起動不能に直結しない。

## 4. Claude Code の非対話実行

**決定: `claude -p --output-format json --json-schema <schema>` を Claude Runner の標準呼び出しとする。**

実測（`evidence/claude-runner-smoke.json`、exit code 0）:

```
claude -p "..." --output-format json --json-schema '{...}' --permission-prompts none --model sonnet
→ {"is_error":false,"subtype":"success","num_turns":2,
   "session_id":"ddd1e461-...","total_cost_usd":0.0889,
   "result":"{\"ok\":true,...}","structured_output":{"ok":true,"note":"runner smoke test"},
   "permission_denials":[], "terminal_reason":"completed"}
```

得られた事実:

| 必要事項（指示書 §6-1） | 実測結果 |
|---|---|
| 非対話実行 | `-p / --print` |
| 入力の渡し方 | `--input-format text`（既定）/ `stream-json`。本実装は**引数に指示本文を埋めず stdin で渡す**（§6-2） |
| 構造化出力 | `--json-schema` + `--output-format json` で `structured_output` が返る。**CLI 側でスキーマ検証済み** |
| セッション継続 | `--resume <session-id>` / `--continue` / `--session-id <uuid>` / `--fork-session` |
| 権限モード | `--permission-mode acceptEdits\|auto\|bypassPermissions\|manual\|dontAsk\|plan`、`--permission-prompts host\|none` |
| 予算・制御 | `--max-budget-usd`、`--model`、`--add-dir`、`--allowedTools` / `--disallowedTools` |
| 終了コード | 成功時 0。異常は `is_error` と非 0 の組み合わせで判定する |
| Remote Control との共存 | 別プロセス・別タスク。§11-4 のとおり Remote Control は補助経路であり、キューの永続化には使わない |

`--max-turns` は**この版の CLI に存在しない**（`--help` 全文を `evidence/claude-help.txt` に保存済み）。想像で実装せず、ターン数の暴走は `--max-budget-usd` とタイムアウトで抑える。

**権限モードは実測で決めた。** 同じプロンプト（Bash で `node -e "console.log(42)"` を実行させる）で比較した結果:

| 設定 | 結果 | 拒否件数 |
|---|---|---|
| `acceptEdits` + `--permission-prompts none` | 拒否 | 1 |
| `auto` + `--permission-prompts none` | 拒否 | 1 |
| `dontAsk` + `--permission-prompts none` | 拒否 | 1 |
| `acceptEdits` + `--allowedTools Bash` | **成功** | 0 |
| `acceptEdits` + `--allowedTools 'Bash(node:*)'` | **成功** | 0 |
| `bypassPermissions` | 成功 | 0 |

つまり `--permission-prompts none` だけでは Bash が「承認できる主体が居ない」として
自動拒否され、テストもビルドも走らない。これは実 E2E で実際に起きた
（1 回目の実行が全コマンド exit -1 で blocked になった）。

**採用: `acceptEdits` + パターン付き許可リスト (`claude.allowedTools`) + 拒否リスト
(`claude.disallowedTools`)。** `bypassPermissions` で全部素通しにするのは指示書 §12 の
安全境界に反するため採らない。許可リストにはテスト・ビルド・調査・作業ブランチへの
コミットに必要なコマンドだけを列挙し、拒否リストで `git push` / `reset` / `checkout` /
`stash` / `clean`、`rm`、`ampx`、`aws`、`gh`、`npm publish`、`curl` を塞ぐ。

## 5. OpenAI Review Engine

**決定: 既存 `lib/ai/openai.ts` と同じ規約（`fetch` + `OPENAI_API_KEY` / `OPENAI_MODEL`）で、Chat Completions の Structured Outputs (`response_format: {type:"json_schema", strict:true}`) を使う。**

- 既存実装が `fetch` ベースで SDK を入れていないため、規約を合わせる（§1-3 既存実装を重複実装しない）。
- 廃止 API は使わない。Chat Completions は現行 API であり、`json_schema` による strict 構造化出力に対応する。
- **実測: `OPENAI_API_KEY` は `.env` にも現在の環境変数にも未設定。** よって指示書 §7-1・§8-3 に従い、キー無しでもシステム全体が起動し、`awaiting_ai_review` 状態とユーザー TODO を生成する構成にする。

## 6. Windows 常駐

**決定: 既存 `tools/windows-claude-host` の Supervisor 方式を再利用し、Orchestrator 用に第 2 のタスクを分離登録する。**

- 既存タスク `\BELLO\ClaudeCodeRemoteControl` は**壊さない**（§11-1）。本日その根本原因調査と修正を完了済み（コミット `ea66a88`、実測値は `docs/TEST-RESULTS.md` §3-2）。
- Orchestrator は `\BELLO\BelloDevOrchestrator` として登録する。
- 常駐の設計（ログオントリガ＋1 分ウォッチドッグ、Mutex + `MultipleInstances=IgnoreNew` の二重防御、指数バックオフ、crash-loop 停止、スリープ抑止、コンソール喪失検知）は Remote Control ホストで**実測合格した方式をそのまま踏襲する**。

## 7. UI

**決定: `node:http` による独立ローカルダッシュボード。既定 `127.0.0.1` 限定。**

Next.js 本体（`app/`）には一切手を入れない（§10 独立ローカル画面 / §3 密結合させない）。
LAN 公開は明示設定 + 共有トークン認証を必須とし、既定は無効（§10-4）。

## 8. 秘密情報

- 設定（非秘密）: `tools/bello-dev-orchestrator/bello-orchestrator.config.json`（Git 管理）
- 秘密: 環境変数のみ。`.env.example` に**変数名と説明だけ**追記する。
- 実行時データ（DB・ログ・inbox・アップロード）: `%LOCALAPPDATA%\BELLO\dev-orchestrator\` に置き、Git 管理外（§13-3）。
- ログ・API 応答・完了報告は `src/log/redact.mjs` を通す（§13-2）。
