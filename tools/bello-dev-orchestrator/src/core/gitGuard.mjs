/**
 * Git の危険な使い方を、実行前に機械的に止める番人。
 *
 * このシステムは他人（ユーザー本人や別の Claude セッション）と同じリポジトリを
 * 共有する。無差別ステージや破壊的コマンドは、他人の作業を一瞬で巻き込む。
 * 「書かないようにする」だけでは足りないので、書いても実行できないようにする。
 *
 * ここを通らない git 実行を作らないこと。git.mjs の runGit がこの唯一の入口。
 */

export class ForbiddenGitCommandError extends Error {
  constructor(message, args) {
    super(message);
    this.name = "ForbiddenGitCommandError";
    this.args = args;
  }
}

/** 常に禁止するサブコマンド。理由つきで列挙する。 */
const FORBIDDEN_SUBCOMMANDS = new Map([
  ["stash", "他人の未コミット変更を退避してしまうため"],
  ["clean", "追跡外ファイルを消してしまうため"],
  ["rebase", "履歴を書き換えるため"],
  ["filter-branch", "履歴を書き換えるため"],
  ["push", "外向きの操作は人の判断が要るため"],
  ["reflog", "expire などで復旧手段を壊しうるため"],
]);

/** 引数の並びから、実際のサブコマンドを取り出す（-C <path> などを読み飛ばす）。 */
export function extractSubcommand(args) {
  const takesValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (takesValue.has(a)) {
      i += 1;
      continue;
    }
    if (a.startsWith("-")) continue;
    return { name: a, rest: args.slice(i + 1) };
  }
  return { name: null, rest: [] };
}

/**
 * 実行してよいかを判定する。危険なら ForbiddenGitCommandError を投げる。
 * 判定は「許可されているものだけ通す」ではなく「危険なものを確実に落とす」方式。
 * 読み取り系まで許可リストで縛ると、診断や調査のたびに壊れるため。
 */
export function assertGitCommandAllowed(args) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  const { name, rest } = extractSubcommand(argv);

  if (!name) {
    throw new ForbiddenGitCommandError("git のサブコマンドがありません。", argv);
  }

  const forbidden = FORBIDDEN_SUBCOMMANDS.get(name);
  if (forbidden) {
    throw new ForbiddenGitCommandError(`git ${name} は禁止されています（${forbidden}）。`, argv);
  }

  if (name === "add") {
    // 無差別ステージの禁止。ここが今回の中心。
    for (const a of rest) {
      if (a === "-A" || a === "--all" || a === "-u" || a === "--update" || a === "--no-ignore-removal") {
        throw new ForbiddenGitCommandError(
          `git add ${a} は禁止されています。変更したファイルを 1 つずつ明示してください。`,
          argv,
        );
      }
      if (a === "." || a === "./" || a === "*" || a === ":/" || a === ":") {
        throw new ForbiddenGitCommandError(
          `git add ${a} は禁止されています。変更したファイルを 1 つずつ明示してください。`,
          argv,
        );
      }
    }
    // パス指定が 1 つも無い add も無差別ステージになりうる
    const sep = rest.indexOf("--");
    const paths = sep >= 0 ? rest.slice(sep + 1) : rest.filter((a) => !a.startsWith("-"));
    if (paths.length === 0) {
      throw new ForbiddenGitCommandError("git add にパスが指定されていません。", argv);
    }
  }

  if (name === "commit") {
    for (const a of rest) {
      if (a === "-a" || a === "--all" || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a)) {
        throw new ForbiddenGitCommandError(
          `git commit ${a} は禁止されています（追跡中の全変更を巻き込むため）。先に明示的に add してください。`,
          argv,
        );
      }
      if (a === "--amend") {
        throw new ForbiddenGitCommandError("git commit --amend は禁止されています（履歴を書き換えるため）。", argv);
      }
    }
  }

  if (name === "reset") {
    if (rest.includes("--hard") || rest.includes("--merge") || rest.includes("--keep")) {
      throw new ForbiddenGitCommandError(
        "git reset --hard / --merge / --keep は禁止されています（作業ツリーを壊すため）。",
        argv,
      );
    }
  }

  if (name === "checkout" || name === "restore") {
    // ファイルを元に戻す形（他人の変更を消す）だけを止める。
    // ブランチ切り替えや worktree の checkout は通す。
    if (rest.includes("--") || rest.includes("--worktree") || rest.includes("--staged")) {
      throw new ForbiddenGitCommandError(
        `git ${name} でファイルを復元する形は禁止されています（未コミット変更を消すため）。`,
        argv,
      );
    }
  }

  if (name === "worktree" && rest[0] === "remove" && rest.includes("--force")) {
    throw new ForbiddenGitCommandError(
      "git worktree remove --force は禁止されています。未コミットの成果ごと消えるため、安全確認を通してください。",
      argv,
    );
  }

  return true;
}

/** Claude に渡す拒否リスト。CLI 側でも同じ操作を塞ぐ（二重防御）。 */
export const FORBIDDEN_BASH_PATTERNS = Object.freeze([
  "Bash(git add -A:*)",
  "Bash(git add --all:*)",
  "Bash(git add .:*)",
  "Bash(git add -u:*)",
  "Bash(git commit -a:*)",
  "Bash(git commit --all:*)",
  "Bash(git commit --amend:*)",
  "Bash(git push:*)",
  "Bash(git reset:*)",
  "Bash(git checkout:*)",
  "Bash(git restore:*)",
  "Bash(git stash:*)",
  "Bash(git clean:*)",
  "Bash(git rebase:*)",
  "Bash(git filter-branch:*)",
  "Bash(git worktree:*)",
]);
