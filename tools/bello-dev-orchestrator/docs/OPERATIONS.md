# 運用手順

## 1. Windows セットアップ

### 1.1 前提

- Windows 10 / 11
- Node.js **22.5 以降**（`node:sqlite` を使うため）。本 PC の実測値は v24.20.0。
- Claude Code がインストール済みで、`claude` にログイン済みであること
- Git

### 1.2 手順

```powershell
cd "C:\Users\win\Documents\GitHub\aws-amplify-system\tools\bello-dev-orchestrator"
powershell -ExecutionPolicy Bypass -File .\bello.ps1 install
```

管理者権限は不要です。Scheduled Task はご自身のユーザーとして登録され、パスワードは保存されません。

### 1.3 何が確認できれば成功か

```powershell
powershell -ExecutionPolicy Bypass -File .\bello.ps1 status
```

- `プロセス      : 稼働中 (pid …)` と表示される
- ブラウザで <http://127.0.0.1:4319/> が開き、「接続 正常」と出る
- `bello.ps1 diagnose` がすべて `[ OK ]`

**API キーは要りません。** 既定の審査方式は「Claude審査」で、いまお使いの Claude Code の枠内で動きます。

### 1.4 OpenAI API キー（任意。設定しなくて構いません）

**設定は不要です。** 既定の Claude審査は OpenAI を使わないため、`OPENAI_API_KEY` が無くても
エラーにもユーザー TODO にもなりません。診断では「任意のオプション」として表示されるだけです。

OpenAI で審査したい場合（API 利用量に応じた課金が発生します）だけ、次を設定してください。

```powershell
[Environment]::SetEnvironmentVariable('OPENAI_API_KEY','<キー>','User')
powershell -ExecutionPolicy Bypass -File .\bello.ps1 restart
```

**確認方法**: `bello.ps1 diagnose` で `[INFO] OpenAI 連携 設定済み` と出ること。
そのうえでダッシュボードの「設定」画面から「OpenAI審査」を選ぶと使われます。
キーの値はダッシュボードにもログにも出ません。

---

## 2. 日常運用

### 2.1 開発指示を出す

ダッシュボード → ホーム → 「新しい開発指示を登録」。

- **件名** は後から一覧で探す手がかりになります。
- **指示内容** には「何を」「なぜ」「どうなれば完了か」を書いてください。受入条件が曖昧だと、
  審査エンジンが `pause_for_user_review` にして人に戻します（勝手に仕様を広げないため）。
- **優先度** は大きいほど先に実行されます（既定 50）。

同じ件名・同じ内容を二度登録しても、冪等性キーにより二重には積まれません。

コマンドラインからも登録できます。

```powershell
node src\cli.mjs add-task --title "在庫検索を速くする" --file .\instruction.txt --priority 70
node src\cli.mjs list-tasks
```

### 2.2 画面の構成

メニューは 4 つだけです。PC では左サイド、スマートフォンでは画面下部に出ます。

| 画面 | 見えるもの |
|---|---|
| **ホーム** | ユーザー様の作業（最上部）、稼働状態、いま進めている作業（開始時刻・経過時間・工程・実装Claude → 審査Claude → 完了の進行）、次に実行する作業、直近の完了結果 |
| **開発履歴** | 実行中 / 審査中 / 修正中 / 完了 / 失敗の一覧。選ぶと指示内容・変更ファイル・テスト結果・審査結果・Git 情報・ログ（技術的な内容は折りたたみの中） |
| **指示を追加** | Word のドラッグ＆ドロップ、取り込んだ文書と実行予定順、文章での指示 |
| **設定** | 審査方法の選択。高度な設定と診断は折りたたみの中 |

通常はホームを見るだけで状況が分かります。ユーザー様の作業が 0 件のときは
「現在、ユーザー様の作業はありません」と出ます。

画面は 10 秒ごとに自動更新します（経過時間は毎秒）。更新できていないときは
「接続 失敗」と赤字で出ます（成功したように見せません）。

### 2.3 止める・再開する

| 目的 | 操作 |
|---|---|
| 一時的にタスクの取得を止める | ダッシュボードの「一時停止」。再開は「再開」 |
| 実行中の 1 タスクだけ止める | ダッシュボードの「現在タスクを安全に停止」 |
| システムごと止める | `bello.ps1 stop` |
| 再開する | `bello.ps1 start`（停止フラグと crash-loop クールダウンを自動で解除します） |
| 待機フラグだけ解除する | `bello.ps1 resume` |

`bello.ps1 stop` は停止フラグを書きます。**ウォッチドッグはこのフラグを尊重して待機します**ので、
1 分後に勝手に再起動することはありません。再開は `bello.ps1 start` です。

---

## 3. ユーザー TODO の処理

ダッシュボード最上部に「今、ユーザー様が行う必要があること」が出ます。開発ログより優先して表示されます。

各 TODO には次が書かれています。

- 分類（認証 / MFA / OAuth / 実画面レビュー / 承認 / 課金 / 破壊的操作 / 仕様判断 / その他）
- なぜ必要か
- **PC が必要か、iPhone でもできるか**
- 想定所要時間
- 操作手順
- **完了条件**（これを満たしてからチェックしてください）
- 待機している開発タスク

### 完了のしかた

1. 完了条件を満たす操作を実際に行う
2. 回答欄がある TODO は必ず入力する（空のままでは完了できません。サーバ側で拒否します）
3. 「完了にする」を押す

完了すると、その TODO を待っていたタスクが**一度だけ**自動再開します。
同じタスクを待つ TODO が他にも残っている場合は、すべて完了するまで再開しません。

> 完了を取り消したい場合: 既に実行が始まったタスクは自動では巻き戻しません。
> ダッシュボードでタスクを取り消すか、追加の指示を出してください。

---

## 4. Word 指示書の投入

### 4.1 2 つの方法

1. ダッシュボード → 「レビュー文書」 → `.docx` を選んで「アップロードして取り込む」
2. inbox フォルダに `.docx` を置く（既定 `%LOCALAPPDATA%\BELLO\dev-orchestrator\inbox`）

inbox は 10 秒ごとに確認します。

### 4.2 取り込みの決まり

- **書き込み途中のファイルは掴みません**。サイズと更新日時が安定してから読みます。
- Word の一時ファイル `~$....docx` は無視します。
- 同じ内容（SHA-256 が同じ）のファイルは二重登録しません。
- 同じ名前の新しい版は、旧版と関連付けて別文書として扱います。
- 元ファイルは削除しません。成功なら `processed`、失敗なら `error` へ移動します。
- `.doc`（旧形式）には対応していません。Word で開いて `.docx` として保存し直してください。
- マクロ・埋込みオブジェクト・外部リンクは**一切実行しません**。存在すれば警告として表示します。
- **画像内の文字は読み取りません**。画像がある文書では「画像だけに要件が書かれていないか確認してください」
  と表示します。

### 4.3 タスクにする

「レビュー文書」画面で抽出結果を確認し、「開発タスクとしてキューに登録」を押します。
文書の本文は**命令ではなく開発要望データ**として Claude に渡されます。
実行中のタスクに割り込むことはなく、キューの順番に従って安全な区切りで始まります。

---

## 5. ログと診断の見方

| 場所 | 内容 |
|---|---|
| `%LOCALAPPDATA%\BELLO\dev-orchestrator\logs\supervisor-YYYYMMDD.log` | 監督プロセス。起動・終了・再起動・crash-loop |
| `%LOCALAPPDATA%\BELLO\dev-orchestrator\logs\orchestrator.log` | Orchestrator 本体 (JSON 1 行 1 レコード) |
| `%LOCALAPPDATA%\BELLO\dev-orchestrator\runs\<taskId>\` | タスクごとの Claude stdout / stderr / 渡した指示 |
| `%LOCALAPPDATA%\BELLO\dev-orchestrator\evidence\` | `diagnose` の結果 |
| ダッシュボード → 監査ログ | 誰が・いつ・何を |

ログはすべて秘密情報を除去してから書かれます。ローテーションは 5MB × 10 世代、保持 30 日です。

### 診断

```powershell
powershell -ExecutionPolicy Bypass -File .\bello.ps1 diagnose
```

Node、node:sqlite、リポジトリ、Claude Code、OpenAI 設定の有無、データ置き場、DB 整合性、
2 つの Scheduled Task、キュー内訳を確認し、`evidence/` に JSON で保存します。

> **Scheduled Task の `LastResult` が `0x800710E0` でも異常ではありません。**
> これは「既に実行中のインスタンスがあるため、1 分ごとのウォッチドッグの起動をスキップした」
> という印で、`MultipleInstances=IgnoreNew` が正しく効いている状態です
> (Task Scheduler の Operational ログではイベント ID 322)。
> 実行中を表す `0x41301`、正常終了の `0x0` と並んで、健全な値です。

### 作業場所と成果ブランチ

```powershell
node src\cli.mjs worktrees        # タスクごとの作業場所・ブランチ・削除可否
node src\cli.mjs prune-worktrees  # 安全確認を通ったものだけ削除（ブランチは残す）
```

成果は `bello/task/<taskId>` ブランチに入ります。**基準ブランチへの自動マージはしません。**
取り込むかどうかはご自身の判断で、`git merge bello/task/<taskId>` を実行してください。

### 修復

```powershell
powershell -ExecutionPolicy Bypass -File .\bello.ps1 repair
```

安全に直せるものだけを直します（死んだ PID ファイルの掃除、DB 整合性の確認）。
**DB の自動再作成はしません**（タスク履歴を失うため）。

---

## 6. 設定を変える

`bello-orchestrator.config.json` を編集し、`bello.ps1 restart` します。
不正な設定では起動せず、理由を日本語で表示します（黙って既定値で動くことはありません）。

主な項目:

| 項目 | 既定 | 意味 |
|---|---|---|
| `review.provider` | `claude` | 既定の審査方式。実際に使う値はダッシュボードの選択が優先されます |
| `review.claude.model` | `sonnet` | 審査担当のモデル |
| `review.claude.maxBudgetUsd` | 1 | 1 回の審査の費用上限 |
| `review.claude.timeoutSeconds` | 900 | 審査のタイムアウト |
| `claude.model` | `sonnet` | 実装担当のモデル |
| `claude.permissionMode` | `acceptEdits` | ファイル編集は自動 |
| `claude.allowedTools` | 35 項目 | **実行を許可するコマンドの列挙**。ここに無い Bash コマンドは自動拒否されます。実測: 許可リストが空だとテストもビルドも一切走りません |
| `claude.disallowedTools` | 19 項目 | 許可リストより強い拒否。`git push` / `reset` / `checkout` / `stash` / `clean`、`rm`、`ampx`、`aws`、`gh`、`npm publish`、`curl` |
| `claude.maxBudgetUsd` | 5 | 1 タスクの API 費用上限 |
| `claude.timeoutSeconds` | 3600 | 1 タスクの全体タイムアウト |
| `claude.idleTimeoutSeconds` | 900 | 無出力の判定閾値（CPU と子プロセスも見てから止めます） |
| `review.maxRevisions` | 3 | 自動修正の上限 |
| `queue.maxAttempts` | 3 | 異常終了時の再試行上限 |
| `git.isolation` | `worktree` | タスクごとに専用 worktree + 専用ブランチ。`in-place` は非推奨 |
| `git.allowInPlaceFallback` | true | worktree を作れないとき同一ツリーへ落ちてよいか |
| `git.removeWorktreeWhenSafe` | false | 既定では worktree を残します（証拠として保持） |
| `git.autoCommit` | true | 証拠ゲート合格時に**専用ブランチ**へコミット |
| `git.protectedBranches` | main / master / production | ここでは絶対に自動コミットしません |
| `dashboard.lanAccess` | false | LAN 公開。有効にするには認証トークン必須 |

### 審査方式の選び方

審査方式には **Claude審査 / OpenAI審査 / 手動審査** の 3 つがあり、既定は **Claude審査** です。

| 方式 | 内容 |
|---|---|
| Claude審査（既定） | 実装を担当したセッションとは別の、まっさらな Claude Code セッションが審査します。OpenAI API は使わず、**追加の API 課金は発生しません** |
| OpenAI審査 | `OPENAI_API_KEY` を使って審査します。キー未設定のままだと審査待ちで止まり、ユーザー TODO が出ます（[1.4](#14-openai-api-キー任意後からで可) 参照） |
| 手動審査 | 人が完了報告を確認して判定します |

切り替えはダッシュボードの **「設定」画面**で行います。選ぶとその場で反映され、**再起動は不要**です
（`bello.ps1 restart` は不要。次に審査が走るときから新しい方式が使われます）。

Claude審査中に利用中の Claude Code セッションの認証が切れた場合は、タスクの状態を保存したまま審査待ちで停止し、ユーザー TODO（分類: 認証、緊急）が出ます。`/login` でログインし直せば、そのタスクは最初からやり直しにはならず、審査待ちの続きから自動で再開します。

### LAN（iPhone）から見る場合

1. `dashboard.host` を `0.0.0.0` に、`dashboard.lanAccess` を `true` に変更
2. `BELLO_DASHBOARD_TOKEN` 環境変数に十分長いランダム文字列を設定
3. Windows ファイアウォールで該当ポートの受信を許可（**この操作はユーザー TODO になります**）
4. iPhone から `http://<PCのIP>:4319/?token=<トークン>`

トークンが無い状態で `lanAccess` を有効にすると、**起動を拒否します**。無認証で LAN に出しません。
インターネットへの直接公開はしないでください。

---

## 7. 常駐を解除する

```powershell
powershell -ExecutionPolicy Bypass -File .\bello.ps1 uninstall
```

Scheduled Task だけを解除します。プログラム、DB、ログ、取込済み文書は残ります。
実行時データも消す場合は `%LOCALAPPDATA%\BELLO\dev-orchestrator` を手動で削除してください。
Remote Control のタスク `\BELLO\ClaudeCodeRemoteControl` には触れません。
