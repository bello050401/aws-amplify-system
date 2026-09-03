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
- `bello.ps1 diagnose` がすべて `[ OK ]`（OpenAI だけは未設定でも構いません）

### 1.4 OpenAI API キー（任意・後からで可）

未設定でもシステムは動きます。設定するまで、完了報告は `AI審査待ち` で止まり、ユーザー TODO が 1 件出ます。

```powershell
[Environment]::SetEnvironmentVariable('OPENAI_API_KEY','<キー>','User')
powershell -ExecutionPolicy Bypass -File .\bello.ps1 restart
```

**確認方法**: `bello.ps1 diagnose` で `[ OK ] OpenAI 審査 設定済み` と出ること。
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

### 2.2 進捗を見る

- **ホーム**: 稼働状態、現在タスク、次タスク、キュー内訳、最終ハートビート
- **タスク一覧 → 詳細**: 元指示、完了報告、審査履歴、状態履歴、変更ファイル
- **監査ログ**: いつ誰が何をしたか

画面は 10 秒ごとに自動更新します。更新できていないときは「接続 失敗」と赤字で出ます
（成功したように見せません）。

### 2.3 止める・再開する

| 目的 | 操作 |
|---|---|
| 一時的にタスクの取得を止める | ダッシュボードの「一時停止」。再開は「再開」 |
| 実行中の 1 タスクだけ止める | ダッシュボードの「現在タスクを安全に停止」 |
| システムごと止める | `bello.ps1 stop` |
| 再開する | `bello.ps1 start` |

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
| `claude.model` | `sonnet` | 使用モデル |
| `claude.permissionMode` | `acceptEdits` | ファイル編集は自動、プロンプトが要るものは自動拒否 |
| `claude.maxBudgetUsd` | 5 | 1 タスクの API 費用上限 |
| `claude.timeoutSeconds` | 3600 | 1 タスクの全体タイムアウト |
| `claude.idleTimeoutSeconds` | 900 | 無出力の判定閾値（CPU と子プロセスも見てから止めます） |
| `review.maxRevisions` | 3 | 自動修正の上限 |
| `queue.maxAttempts` | 3 | 異常終了時の再試行上限 |
| `git.autoCommit` | true | 証拠ゲート合格時に作業ブランチへコミット |
| `git.protectedBranches` | main / master / production | ここでは絶対に自動コミットしません |
| `dashboard.lanAccess` | false | LAN 公開。有効にするには認証トークン必須 |

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
