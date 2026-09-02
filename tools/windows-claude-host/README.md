# BELLO 開発用 Claude Code 常時稼働ホスト (Windows)

Windows PC を BELLO 開発用の常時稼働端末として使うための、
Claude Code **Remote Control** 起動・監視・自動復旧セットです。

対象リポジトリ: `C:\Users\win\Documents\GitHub\aws-amplify-system`

このディレクトリはローカル開発環境の可用性改善のみを目的としています。
アプリケーションコード / main / Production / AWS 環境には一切影響しません。

---

## 1. これが解決する事故

| 事故 | 対策 |
|---|---|
| PowerShell を閉じた | タスクスケジューラが次回ログオン時に再起動。手動なら `Start-BelloClaudeHost.ps1` 1 本 |
| Claude Code が異常終了した | 監視ループが指数バックオフで再起動 |
| 異常終了を繰り返す | 10 分に 5 回でループを止め、理由をログに残す（無限再起動しない） |
| Windows Update / 手動で再起動した | ログオン時に自動起動（45 秒遅延でネットワーク待ち） |
| PC がスリープして切断された | AC 電源接続中はシステムスリープを抑止（画面 OFF とロックはそのまま） |
| 二重起動した | 名前付き Mutex + タスク側 `IgnoreNew` で 1 プロセスのみ |
| 何が起きたか分からない | 起動 / 終了 / 異常終了 / 再起動をすべてログファイルに記録 |

---

## 2. 起動方式（公式仕様に基づく）

Claude Code の Remote Control には 3 つの起動方法があり、本ツールは
**サーバーモード** を使います。

```
claude remote-control --name "BELLO-dev" --debug-file <ログパス>
```

サーバーモードを選んだ理由:

- 常駐プロセスとして動く前提の公式モード
- 停止後に**同じディレクトリで再実行するとセッションが復帰する**
  （サーバーが持っていたセッションを約 4 時間以内なら引き戻せる）
- 会話を手で打ち込まなくても起動が完結する

重要な仕様（推測ではなく公式ドキュメント準拠）:

- フラグは **`remote-control` の後ろ**に置く必要があります。前に置くと Claude Code が起動を拒否します。
- Remote Control は Pro / Max / Team / Enterprise ログインが必要です。**API キーでは使えません。**
- 送信は**すべて外向き HTTPS のみ**。PC 側で受信ポートは一切開きません。

### 実行ファイルの探索順

`Start-BelloClaudeHost.ps1` は安定する順に自動探索します。

1. PATH 上の `claude`
2. ネイティブ版 `%USERPROFILE%\.local\bin\claude.exe`
3. npm グローバル `%APPDATA%\npm\claude.cmd`
4. `npx.cmd --yes @anthropic-ai/claude-code`（フォールバック）

現状この PC は 4 番の npx でのみ起動できる状態です。npx は**起動のたびに
パッケージを解決する**ため遅く、ネットワーク断で失敗します。
セットアップスクリプトは 1〜3 が見つからない場合、公式インストーラ
(`https://claude.ai/install.ps1`, stable チャンネル, 管理者権限不要) で
ネイティブ版を導入します。導入後は 2 番の絶対パスで起動するため、
PATH の再読み込みを待つ必要がありません。

---

## 3. ファイル

| ファイル | 役割 |
|---|---|
| `bello-claude-host.config.psd1` | 設定（リポジトリパス、セッション名、再起動しきい値など）。**認証情報は一切入れない** |
| `Start-BelloClaudeHost.ps1` | 本体。単一起動保証・起動・監視・再起動・スリープ抑止・ログ |
| `Install-BelloClaudeHost.ps1` | 環境調査 → 既存自動起動の重複確認 → タスク登録（管理者権限不要） |
| `Test-BelloClaudeHost.ps1` | 検証スイート。異常終了・多重起動防止まで実地テスト |
| `Get-BelloClaudeHostStatus.ps1` | 現在の状態確認（読み取りのみ） |
| `Stop-BelloClaudeHost.ps1` | 再起動させずに安全停止 |
| `Uninstall-BelloClaudeHost.ps1` | 全部元に戻す |

---

## 4. セットアップ

PowerShell を**管理者権限なし**で開いて実行します。

```powershell
cd C:\Users\win\Documents\GitHub\aws-amplify-system\tools\windows-claude-host
powershell -ExecutionPolicy Bypass -File .\Install-BelloClaudeHost.ps1
```

`-ExecutionPolicy Bypass` はこの 1 回の実行だけに効きます。
システムの実行ポリシーは変更しません。

主なオプション:

| オプション | 意味 |
|---|---|
| `-ReportOnly` | 調査だけして何も変更しない |
| `-InstallNative never` | ネイティブ版の自動導入をしない |
| `-ConfigurePower` | 電源プランの AC スリープを「なし」に恒久変更（既定 OFF） |
| `-Hidden` | コンソールウィンドウを出さずに常駐 |
| `-StartDelaySeconds 45` | ログオンから起動までの待ち |

### あなた自身の操作が必要な部分（自動化できません）

Remote Control の認証だけは本人操作が必要です。**初回 1 回だけ**です。

```powershell
cd C:\Users\win\Documents\GitHub\aws-amplify-system
claude
```

1. `/login` を実行してブラウザでサインイン（Pro / Max / Team / Enterprise アカウント）
2. 同じ初回起動で、リポジトリの **workspace trust（信頼）確認に承認**する

この 2 つを済ませれば、以降タスクスケジューラ側は保存済みのログインを使い、
再ログイン不要で自動起動します。

---

## 5. 検証

```powershell
powershell -ExecutionPolicy Bypass -File .\Test-BelloClaudeHost.ps1
```

チェック内容:

1. スクリプトの存在と構文
2. 設定とリポジトリ
3. Claude Code の実体・バージョン・Remote Control 対応
4. 認証状態と、Remote Control を壊す環境変数
   (`DISABLE_TELEMETRY` / `DO_NOT_TRACK` / `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` /
   `DISABLE_GROWTHBOOK` / `ANTHROPIC_BASE_URL`)
5. 起動スクリプトのドライラン + ログ出力
6. **二重起動防止**（Mutex を実際に奪って検証）
7. **異常終了時の挙動とクラッシュループ保護**（一時ディレクトリで実際に失敗させて検証）
8. タスクスケジューラの登録内容
9. AC 電源とスリープ抑止

実際に Remote Control を張るところまで通したい場合:

```powershell
powershell -ExecutionPolicy Bypass -File .\Test-BelloClaudeHost.ps1 -Live
```

（サインイン済みであることが前提。90 秒起動して自動停止します）

---

## 6. タスクスケジューラの設定内容

| 項目 | 値 |
|---|---|
| 場所 | `\BELLO\ClaudeCodeRemoteControl` |
| トリガー | このユーザーのログオン時（既定 45 秒遅延） |
| 実行アカウント | 自分。`LogonType=Interactive`, `RunLevel=Limited` |
| パスワード保存 | **なし**（対話ログオン方式のため） |
| 多重起動 | `IgnoreNew`（既に動いていれば新規起動しない） |
| 実行時間制限 | なし |
| バッテリー | バッテリーでも起動する / 切り替えても止めない |
| タスク自体の失敗時 | 5 分間隔で最大 3 回リトライ |
| アイドル | アイドル終了で停止しない |

管理者権限は不要です。ユーザー自身のタスクとして登録されます。

---

## 7. 自動復旧の条件と限界

### 自動で復旧するケース

- Claude Code が異常終了（終了コード != 0）
  → 5s → 10s → 20s → 40s … 最大 300s のバックオフで再起動
- PC 再起動 / Windows Update 再起動 / ログオフ
  → **次にこのユーザーが Windows にログオンした時点**で自動起動
- 一時的なネットワーク断
  → Claude Code 自身がオンライン復帰時に自動再接続する（公式仕様）
- スリープからの復帰
  → 同上。加えて AC 中はそもそもスリープしない

### 自動で復旧しないケース（意図的にそうしています）

| ケース | 挙動 | 対処 |
|---|---|---|
| 10 分に 5 回異常終了 | 停止して `FATAL` をログに記録（無限ループ防止） | ログを見て原因を直し、手動起動またはログオンし直す |
| 終了コード 0 での終了（Ctrl+C など） | 意図的な停止とみなし再起動しない | 手動起動 |
| `Stop-BelloClaudeHost.ps1` 実行後 | 停止フラグにより再起動しない | 手動起動またはログオンし直す |
| 未ログイン / workspace trust 未承認 | 起動に失敗し続け、5 回でクラッシュループ停止 | 上記「本人操作が必要な部分」を実施 |
| **Windows 再起動後、誰もログオンしていない** | 起動しない | ログオンが必要。無人復帰させたい場合は下記参照 |
| ログイン画面で止まっている（ロック画面ではない） | 起動しない | 同上 |

> **無人でのログオン後自動復帰について**
> ログオン前に起動させるには SYSTEM 権限のタスクにする方法がありますが、
> Claude Code の認証はユーザープロファイルに紐づくため機能せず、
> セキュリティ上も不利です。そのため採用していません。
> Windows Update 再起動後に自動でログオンさせたい場合は、Windows の
> 「更新後にサインイン情報を使用してデバイスのセットアップを自動的に完了する」
> 設定（設定 → アカウント → サインイン オプション）を有効にしてください。
> これは本人が GUI で行う操作で、スクリプトからは変更していません。

### 終了コード

| コード | 意味 |
|---|---|
| 0 | 正常終了、または既に起動済みのため何もしなかった |
| 2 | リポジトリパスが見つからない |
| 3 | Claude Code が見つからない |
| 4 | クラッシュループ保護により停止 |
| 5 | 監視スクリプト自体の想定外エラー |

---

## 8. ログ

```
%LOCALAPPDATA%\BELLO\claude-host\logs\
```

（通常は `C:\Users\win\AppData\Local\BELLO\claude-host\logs\`）

| ファイル | 内容 |
|---|---|
| `supervisor-YYYYMMDD.log` | 起動 / 終了 / 終了コード / 再起動 / バックオフ / クラッシュループ停止理由 |
| `claude-debug-*.log` | Claude Code 自身のデバッグログ（`--debug-file`） |

状態ファイル: `%LOCALAPPDATA%\BELLO\claude-host\state\state.json`
（現在の状態、最終終了コード、失敗回数、参照すべきログのパス）

30 日を過ぎたログは自動削除されます（`LogRetentionDays` で変更可）。

---

## 9. スリープ設定

**画面 OFF と PC スリープは別物として扱っています。**

既定の方式（管理者権限不要・グローバル設定を変更しない・自動で元に戻る）:

- 監視スクリプトが動作中、かつ **AC 電源接続中**のときだけ
  `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` を保持
- **システムスリープのみ**抑止。`ES_DISPLAY_REQUIRED` は**あえて指定していない**ので
  画面は今まで通り消え、ロック画面も通常通り機能します（セキュリティを弱めません）
- バッテリー駆動に切り替わると自動的に抑止を解除（15 秒ごとに判定）
- スクリプトが終了・クラッシュすると Windows が自動的に解除

恒久的に電源プランを変えたい場合のみ:

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-BelloClaudeHost.ps1 -ConfigurePower
```

- 変更対象は **AC 側の `standby-timeout-ac` と `hibernate-timeout-ac` のみ**
- バッテリー側とモニタ OFF 時間は変更しません
- 変更前の値を `state\powercfg-backup.json` に保存し、アンインストール時に復元します
- Windows が管理者権限を要求した場合は、その場で必要なコマンドだけ表示します

---

## 10. 日常の操作

```powershell
# 今すぐ起動（前面で状況を見たいとき）
powershell -ExecutionPolicy Bypass -File .\Start-BelloClaudeHost.ps1

# 状態確認
powershell -ExecutionPolicy Bypass -File .\Get-BelloClaudeHostStatus.ps1

# 再起動させずに安全停止
powershell -ExecutionPolicy Bypass -File .\Stop-BelloClaudeHost.ps1

# タスクを手動で起動
Start-ScheduledTask -TaskName ClaudeCodeRemoteControl -TaskPath \BELLO\
```

起動すると、そのウィンドウにセッション URL が表示されます。
スペースキーで QR コードを表示できます。
スマホ / ブラウザからは [claude.ai/code](https://claude.ai/code) のセッション一覧に
`BELLO-dev` として（緑のドット付きで）現れます。

---

## 11. 元に戻す方法

```powershell
powershell -ExecutionPolicy Bypass -File .\Uninstall-BelloClaudeHost.ps1
```

- 実行中のホストを停止
- タスクスケジューラのタスクを削除
- `-ConfigurePower` で電源設定を変えていた場合は元の値に復元
- ログは残ります（消すなら `-RemoveLogs`）

Claude Code 本体・ログイン情報・リポジトリには一切触れません。
ネイティブ版 Claude Code も消したい場合のみ、手動で:

```powershell
Remove-Item "$env:USERPROFILE\.local\bin\claude.exe" -Force
Remove-Item "$env:USERPROFILE\.local\share\claude" -Recurse -Force
```

このディレクトリごと削除すれば、残るものは何もありません。

---

## 12. セキュリティ方針

- **認証情報をスクリプトに一切書きません。** Claude Code のログイン、AWS
  credentials、GitHub token はすべてそれぞれの標準の保管場所を使います。
  設定ファイル `bello-claude-host.config.psd1` は git にコミットされますが、
  秘密情報は含みません。
- 管理者権限を要求しません。タスクは自分のユーザーとして `RunLevel=Limited` で動きます。
- タスクにパスワードを保存しません。
- システムの実行ポリシーを変更しません（`-ExecutionPolicy Bypass` は都度実行のみ）。
- 画面ロック / 画面 OFF を無効化しません。
- 受信ポートを開きません（Remote Control は外向き HTTPS のみ）。
- ファイアウォール規則を追加しません。
