# Git の作業分離

このシステムは、ユーザー本人・別の Claude Code セッション・Remote Control セッションと
**同じリポジトリを共有**します。分離が甘いと、他人の作業を一瞬で巻き込みます。

実際に 2026-09-03、別セッションのコミットへ本システムの作業中ファイルが混入する事故が起きました。
その反省から、分離を「気をつける」ではなく **構造と権限で担保する**設計にしています。

---

## 1. 3 段の防御

| # | 防御 | 何を防ぐか |
|---|---|---|
| 1 | **タスク専用 worktree** | そもそも他人のファイルが視界に入らない |
| 2 | **明示指定 stage** | 作ったと証明できるファイルだけをコミットする |
| 3 | **Git ガード** | 無差別ステージや破壊的コマンドを実行前に落とす |

### 1.1 タスク専用 worktree

タスクを始めるとき、`%LOCALAPPDATA%\BELLO\dev-orchestrator\worktrees\<taskId>` に
専用の git worktree を作り、`bello/task/<taskId>` ブランチを切ります。

```
本体リポジトリ  C:\Users\win\Documents\GitHub\aws-amplify-system
   ├─ ユーザー本人の未コミット変更          ← 触らない
   ├─ 別 Claude セッションの作業            ← 触らない
   └─ Remote Control セッション             ← 触らない

タスク専用 worktree  %LOCALAPPDATA%\BELLO\dev-orchestrator\worktrees\task_xxx
   └─ 実装 Claude と 審査 Claude はここだけで動く
```

worktree は **基準コミットのきれいな複製**から始まります。開始前の未コミット変更は
複製されないので、触ることも巻き込むこともできません。
そして「worktree で dirty なファイル = このタスクが作ったもの」が構造的に保証されます。

置き場所をリポジトリの外にしているのは、中に置くと本体側の `git status` や検索に混ざり、
別セッションが巻き込む余地が残るためです。

### 1.2 明示指定 stage

自動コミットは、`git add -- <path1> <path2> ...` の形でしか stage しません。
対象は「そのタスクが作ったと確認できたファイル」だけで、さらに次を必ず除外します。

- 開始前から dirty だったファイル（同一ツリー方式のとき）
- `.env` / `.env.local` / `*.pem` / `*.key` / `*.pfx` / `*.p12`
- `*.db` / `*.sqlite` / `*.log`
- inbox / processed / uploads 配下の `.docx`
- 保護ブランチ（`main` / `master` / `production`）ではそもそもコミットしない

stage 後に `git diff --cached --name-only` を読み直し、意図しないファイルが混ざっていれば
`git reset -- <path>` で外し、それでも残るならコミットを中止します。

### 1.3 Git ガード

`src/core/gitGuard.mjs` が、git の実行前に危険な使い方を落とします。
`src/core/git.mjs` の `runGit` が唯一の入口で、ここを通らない git 実行はありません。

| 禁止 | 理由 |
|---|---|
| `git add -A` / `--all` / `.` / `-u` / パス無し | 無差別ステージ |
| `git commit -a` / `--all` / `--amend` | 追跡中の全変更を巻き込む / 履歴改変 |
| `git reset --hard` / `--merge` / `--keep` | 作業ツリーを壊す |
| `git checkout --` / `git restore --` | 未コミット変更を消す |
| `git stash` / `git clean` | 他人の変更を退避・削除する |
| `git rebase` / `filter-branch` | 履歴改変 |
| `git push` | 外向きの操作は人の判断が要る |
| `git worktree remove --force` | 未コミットの成果ごと消える |

同じ操作は Claude 側の `--disallowedTools` でも塞いであります（二重防御）。
**実装 Claude は `git add` も `git commit` もできません。** コミットはシステムが行います。

---

## 2. 記録するもの

タスクごとに次を DB へ残します。ダッシュボードのタスク詳細と
`node src/cli.mjs worktrees` で確認できます。

| 項目 | 内容 |
|---|---|
| `isolation` | `worktree` / `in-place` |
| `worktree_path` | 専用作業場所 |
| `worktree_branch` | `bello/task/<taskId>` |
| `base_commit` / `base_branch` | 基準にしたコミットとブランチ |
| `changed_files` | このタスクが変更したファイル |
| チェックポイント `preflight` | **開始時点の本体リポジトリの `git status` 全行** |
| チェックポイント `workspace` | 作業場所の作成／再利用の記録 |
| チェックポイント `auto_commit` | stage したファイルと除外したファイル |
| チェックポイント `conflict_check` | 競合検査の結果 |

再実行（修正指示など）で worktree を再利用するときは、**最初の基準コミットを引き継ぎます**。
取り直すと、その間に本体へ入った他人のコミットまで「このタスクの変更」に見えてしまうためです。

---

## 3. 競合したとき

タスクが変更したファイルを、本体リポジトリ側でも誰かが触っていた場合、
**自動マージは一切しません。** 緊急の TODO を出して人に判断してもらいます。

検知するのは 2 つです。

1. 基準コミット以降に本体へ入った新しいコミットの変更ファイル
2. 本体リポジトリのいまの未コミット変更

TODO には、重なっているファイル、このタスクのブランチ名、作業場所、
差分を見るコマンドが入ります。

---

## 4. 後始末

**既定では worktree もブランチも消しません。** 成果と証拠を残すためです。

削除は安全確認を通ったときだけ行います。

```powershell
node src\cli.mjs worktrees        # 一覧と削除可否
node src\cli.mjs prune-worktrees  # 安全なものだけ削除（ブランチは残す）
```

「安全」の条件は次の両方です。

- worktree に未コミットの変更が 1 つも無い
- 専用ブランチのコミットが基準ブランチに取り込まれている

`git worktree remove --force` は使いません。

---

## 5. 成果の取り込み

このシステムは**基準ブランチへ自動マージしません**。成果はタスク専用ブランチに残ります。

```powershell
git log --oneline <baseBranch>..bello/task/<taskId>
git diff <baseCommit>..bello/task/<taskId>
git merge bello/task/<taskId>     # 取り込むかどうかはご自身の判断で
```

---

## 6. 設定

| 項目 | 既定 | 意味 |
|---|---|---|
| `git.isolation` | `worktree` | `in-place` にすると本体リポジトリで直接作業します（非推奨） |
| `git.allowInPlaceFallback` | `true` | worktree を作れないとき同一ツリーへ落ちてよいか。`false` ならタスクを失敗させます |
| `git.removeWorktreeWhenSafe` | `false` | `true` にすると、安全確認を通った worktree を自動で消します |
| `git.autoCommit` | `true` | 証拠ゲート合格時に専用ブランチへコミットします |
| `git.protectedBranches` | main / master / production | ここでは絶対にコミットしません |

`in-place` を選んだ場合は起動時に警告が出ます。開始前の未コミット変更は除外できますが、
**作業中に他セッションが作った新規ファイルまでは切り分けられません。**
