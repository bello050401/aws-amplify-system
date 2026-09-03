# 障害復旧

## 1. 何が自動で直るか（実測値つき）

2026-09-03 に本 PC (DESKTOP-91TNKS2 / Windows 10 / PowerShell 5.1.19041.6456 / Node v24.20.0) で、
実際にプロセスを強制終了して測定した結果です。

| 障害 | 復旧の仕組み | 実測復旧時間 | 同時インスタンス数 |
|---|---|---|---|
| Orchestrator (node) が異常終了 | 監督プロセスが 5 秒バックオフで再起動 | **6 秒** | 常に 1 |
| 監督プロセスだけが強制終了 | Scheduled Task の 1 分ウォッチドッグが新しい監督を起動し、**生き残った Orchestrator を引き継ぐ** | **48 秒** | 常に 1（Orchestrator は再起動されず、実行中の作業は失われない） |
| 監督プロセスのコンソールが消える | Orchestrator はコンソールに依存しないため**停止しない** | 停止なし | 常に 1 |
| 監督プロセスと Orchestrator が同時に消える（ウィンドウごと閉じた相当） | 1 分ウォッチドッグが両方を作り直す | **21 秒** | 常に 1 |
| Orchestrator が実行中に落ちた（タスクが `running` のまま） | 起動時の復旧処理が `retry_wait` または `awaiting_user` へ戻す | 再起動と同時 | — |
| Windows Update 等での PC 再起動 | ログオントリガ（45 秒遅延） | **次にこのユーザーがログオンした時点** | — |
| ネットワーク断 | OpenAI 呼び出しは指数バックオフ。タスクは `AI審査待ち` のまま保持 | 回線復旧後の次の tick | — |

いずれも **`MultipleInstances=IgnoreNew`（Task Scheduler イベント ID 322 で実測確認）と名前付き Mutex の
二重防御**により、多重起動は発生しません。

## 2. 自動で直らないケース（意図的にそうしています）

| 状況 | 挙動 | 対処 |
|---|---|---|
| 10 分に 5 回の異常終了 | 監督プロセスが停止し、`crashloop.flag` を書いて**ウォッチドッグを 30 分待機**させる | ログを見て原因を直し、`bello.ps1 start` |
| `bello.ps1 stop` 実行後 | 停止フラグにより、ウォッチドッグも起動しない | `bello.ps1 start` |
| 自動修正が 3 回で収束しない | `awaiting_user` にして TODO を作る | 指示を具体化して再投入、または取消 |
| 同じ失敗理由が連続 | 上限前でも停止 | 原因を直してから再試行 |
| 再試行上限に達した | `failed` にして TODO を作る | ダッシュボードから再試行または取消 |
| **PC 再起動後、誰もログオンしていない** | 起動しない | ログオンが必要（対話ログオン方式のためパスワードを保存していません） |
| DB が壊れた | 起動を拒否し理由を出す。**自動再作成はしない** | バックアップから戻すか、履歴を諦めて DB ファイルを退避 |

## 3. 復旧処理が実際にやること

Orchestrator の起動時 (`Orchestrator.recover()`):

1. 単一起動ロックを取得
2. `PRAGMA integrity_check` で DB の整合性を確認（NG なら起動しない）
3. `awaiting_ai_review` のタスクは**作り直さない**。待っていただけで完了報告は保存済みなので、
   待機指示だけ消して起動直後に審査へ進める（作り直すと成功した Claude 実行を丸ごと捨てることになる）
4. `verifying` のタスクは、完了報告があれば `awaiting_ai_review` へ進めて**審査から再開**する。
   完了報告が無い場合だけ再実行に回す
5. 実際に子プロセスを抱えていた `preflight` / `running` だけを作り直す。監督プロセスが死んだ
   時点でプロセス追跡は不能なので、**セッションを再開せず新しい試行にする**
   （同じ外部操作の二重実行を避けるため）
6. 再試行余地があれば `retry_wait`、上限に達していれば `awaiting_user` + ユーザー TODO
7. チェックポイントと監査ログに記録

### 実測ログ（2026-09-03）

```
task_366e49a34658b2d3d2  state=awaiting_user  attempts=1
   2026-09-03T02:09:45.017Z  - -> queued  [system] created
   2026-09-03T02:09:45.021Z  queued -> preflight  [system] 試験
   2026-09-03T02:09:45.025Z  preflight -> running  [system] 試験: 実行中に落ちた状況を作る
   2026-09-03T02:10:02.146Z  running -> awaiting_user  [recovery] Orchestrator の異常終了から復旧: 直前の状態 running / 再試行上限に到達
   checkpoint: recovery @ 2026-09-03T02:10:02.144Z
--- open TODOs ---
  [approval] 中断したタスクの扱いを決めてください: 復旧試験用タスク  waiting=["task_366e49a34658b2d3d2"]
--- audit ---
  2026-09-03T02:10:02.151Z recovery task.recovered task_366e49a34658b2d3d2 running
```

## 3.5 Scheduled Task の結果コードの読み方

| LastResult | 意味 | 正常か |
|---|---|---|
| `0x41301` | 実行中 (SCHED_S_TASK_RUNNING) | 正常 |
| `0x0` | 直前の実行が正常終了した | 正常 |
| `0x800710E0` | 既に実行中のためウォッチドッグの起動をスキップした (IgnoreNew) | **正常**。多重起動抑止が効いている印 |
| `0x41303` | **一度も実行されていない** (SCHED_S_TASK_HAS_NOT_RUN) | 要確認。2026-09-03 の Remote Control 障害はこれだった |
| `0x1` / その他 | 直前の実行が非 0 で終了した | ログを確認 |

## 4. 症状別の対処

### ダッシュボードが開かない

```powershell
powershell -ExecutionPolicy Bypass -File .\bello.ps1 status
```

- `プロセス: 停止中` → `停止フラグ: あり` なら `bello.ps1 start`。無ければ 1 分待つ（ウォッチドッグ）。
- それでも上がらない → `bello.ps1 diagnose` と `logs\supervisor-*.log` を確認。
- ポートが埋まっている → `bello-orchestrator.config.json` の `dashboard.port` を変えて `restart`。

### 「crash-loop クールダウン中」と出る

10 分に 5 回失敗しました。`logs\supervisor-*.log` の FATAL 行に理由が出ています。
よくある原因は Node の未導入、設定ファイルの不備、データ置き場への書き込み不可です。
直したら `bello.ps1 start`（手動起動はクールダウンを解除します）。

### タスクが `AI審査待ち` から進まない

`bello.ps1 diagnose` で OpenAI が未設定なら、それが原因です。TODO の手順に従ってキーを設定し、
`bello.ps1 restart` してください。キー設定後、待機していたタスクは自動で審査に進みます。

### タスクが `ユーザー様の操作待ち` から進まない

ダッシュボードの TODO 画面を開いてください。完了条件を満たして完了にすると、一度だけ自動再開します。
複数の TODO が同じタスクを待っている場合は、すべて完了するまで再開しません。

### 自分の未コミット変更が消えた気がする

このシステムは `git reset --hard` / `git checkout --` / `git stash` / `git clean` を**一切実装していません**。
自動コミットは、作業開始時点で既に変更されていたファイルを除外します。
`git reflog` と `logs\` で実際に何が起きたか追えます。

## 5. PC 再起動を伴う最終確認（ユーザー操作）

自動では行いません。次の手順でご確認ください。

```text
【ユーザーTODO】
件名: PC 再起動後に自動復帰することを確認する
必要な理由: ログオントリガが実際に発火するかは、実際にログオンしないと確認できないため
PC／iPhone: PC
所要時間: 5 分（再起動時間を除く）
操作手順:
  1. 作業中のものを保存する
  2. Windows を再起動する
  3. いつも通りサインインし、45 秒ほど待つ
  4. PowerShell で:
     cd "C:\Users\win\Documents\GitHub\aws-amplify-system\tools\bello-dev-orchestrator"
     powershell -ExecutionPolicy Bypass -File .\bello.ps1 status
完了条件: 「プロセス: 稼働中 (pid …)」と表示され、http://127.0.0.1:4319/ が開くこと
完了後に自動再開するタスク: なし（確認のみ）
```
