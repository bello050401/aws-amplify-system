/**
 * 設定ファイルの安全な入出力 (文字化け・途中書き込み対策)。
 *
 * 2026-09-03 の障害の原因は、Windows PowerShell 5.1 の
 *   Get-Content -Raw            (エンコーディング指定なし)
 * で BOM 無し UTF-8 の設定ファイルを読んだこと。5.1 の既定は BOM が無いと
 * ANSI コードページ (日本語環境では CP932) なので、UTF-8 のバイト列が
 * CP932 として解釈されて文字化けする。CP932 の 2 バイト目には 0x5C (\) が
 * 含まれるため、化けた文字列をそのまま書き戻すと JSON のエスケープが壊れ、
 * 引用符と改行の対応まで崩れて JSON として読めなくなる。
 *
 * ここでは以下を保証する:
 *   * 読み込みは必ず UTF-8 として厳密にデコードする (不正バイトは黙って捨てない)
 *   * 文字化けを検出して「壊れている」と明示する (既定値で何となく動かさない)
 *   * 書き込みは 一時ファイル → 再読込検証 → atomic replace の順で行う
 *   * 壊れたファイルは絶対に削除せず、SHA-256 付きで隔離保存する
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** UTF-8 BOM。読み込み時は取り除き、書き込み時は付けない。 */
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * UTF-8 のテキストを CP932 (Shift_JIS) として読んでしまったときに現れる文字。
 * ひらがな U+3040-309F は UTF-8 で E3 81 xx / E3 82 xx になり、これを CP932 と
 * みなすと 縺 / 繧 に化ける。カタカナ U+30A0-30FF は E3 83 xx で 繝 に化ける。
 * 日本語の設定コメントが化けていれば、ほぼ確実にこのどれかが現れる。
 */
const CP932_MOJIBAKE_MARKERS = ["縺", "繧", "繝", "蜿", "螳", "譌", "荳", "隱", "陦", "遘", "竊", "繹"];

/**
 * UTF-8 のテキストを Latin-1 / CP1252 として読んでしまったときに現れる並び。
 * 例: 日 (E6 97 A5) → "æ—¥"。先頭バイトが Ã/Â/æ/ç/ã になり、続いて
 * U+0080-U+00BF の制御・記号が並ぶのが特徴。
 */
const LATIN1_MOJIBAKE_RE = /[\u00C0-\u00FF][\u0080-\u00BF]/;

/** 置換文字。デコードに失敗した証拠なので、見つかったら必ず壊れている。 */
const REPLACEMENT_CHAR = "�";

/**
 * JSON の設定ファイルに現れてはいけない制御文字。
 * 文字列の中でも生の制御文字は JSON では不正なので、途中書き込みの兆候になる。
 */
// eslint-disable-next-line no-control-regex
const RAW_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

export function sha256OfBuffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function sha256OfFile(filePath) {
  return sha256OfBuffer(fs.readFileSync(filePath));
}

/**
 * 文字化けの兆候を調べる。戻り値は見つかった問題の配列 (空なら問題なし)。
 * 「化けていないこと」を証明はできないが、実際に起きた化け方は確実に捕まえる。
 */
export function detectMojibake(text) {
  const issues = [];

  if (text.includes(REPLACEMENT_CHAR)) {
    issues.push({
      kind: "replacement_char",
      message: "置換文字 (U+FFFD) が含まれています。読み込み時に文字が失われています。",
      sample: sampleAround(text, text.indexOf(REPLACEMENT_CHAR)),
    });
  }

  for (const marker of CP932_MOJIBAKE_MARKERS) {
    const at = text.indexOf(marker);
    if (at >= 0) {
      issues.push({
        kind: "cp932_mojibake",
        message:
          `UTF-8 を CP932 (Shift_JIS) として読んだ痕跡があります (\`${marker}\`)。` +
          "PowerShell 5.1 の Get-Content にエンコーディング指定が無いと、この化け方をします。",
        sample: sampleAround(text, at),
      });
      break;
    }
  }

  const latin1 = LATIN1_MOJIBAKE_RE.exec(text);
  if (latin1) {
    issues.push({
      kind: "latin1_mojibake",
      message: "UTF-8 を Latin-1 / CP1252 として読んだ痕跡があります。",
      sample: sampleAround(text, latin1.index),
    });
  }

  const control = RAW_CONTROL_RE.exec(text);
  if (control) {
    issues.push({
      kind: "control_char",
      message:
        `生の制御文字 (U+${control[0].charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}) が含まれています。` +
        "書き込みが途中で切れた可能性があります。",
      sample: sampleAround(text, control.index),
    });
  }

  return issues;
}

function sampleAround(text, index, radius = 40) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

/**
 * 設定ファイルを UTF-8 として厳密に読む。
 *
 * 例外は投げない。壊れている場合も同じ形の結果を返し、呼び出し側が
 * 「危険な既定値で動かす」以外の選択 (診断モード) を取れるようにする。
 */
export function readConfigFile(filePath) {
  const result = {
    filePath,
    exists: false,
    bytes: null,
    sha256: null,
    text: null,
    parsed: null,
    hadBom: false,
    issues: [],
  };

  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (err) {
    result.issues.push({ kind: "unreadable", message: `設定ファイルを読めません: ${err.message}` });
    return result;
  }
  result.exists = true;
  result.bytes = bytes;
  result.sha256 = sha256OfBuffer(bytes);

  // UTF-16 の BOM を UTF-8 として読むと必ず壊れるので、先に弾く。
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    result.issues.push({
      kind: "wrong_encoding",
      message: "UTF-16 として保存されています。設定ファイルは BOM 無し UTF-8 で保存してください。",
    });
    return result;
  }

  let body = bytes;
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(UTF8_BOM)) {
    result.hadBom = true;
    body = bytes.subarray(3);
  }

  // fatal: true にすると、不正な UTF-8 バイト列を黙って U+FFFD に潰さず例外にする。
  // CP932 で保存された設定ファイルはここで確実に捕まる。
  try {
    result.text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    result.issues.push({
      kind: "wrong_encoding",
      message:
        "UTF-8 として解釈できないバイト列が含まれています " +
        "(CP932/Shift_JIS で保存された可能性があります)。設定ファイルは BOM 無し UTF-8 で保存してください。",
    });
    return result;
  }

  result.issues.push(...detectMojibake(result.text));

  try {
    result.parsed = JSON.parse(result.text);
  } catch (err) {
    result.issues.push({ kind: "invalid_json", message: `JSON として不正です: ${err.message}` });
    return result;
  }

  if (result.parsed === null || typeof result.parsed !== "object" || Array.isArray(result.parsed)) {
    result.parsed = null;
    result.issues.push({ kind: "invalid_json", message: "設定ファイルの最上位は JSON オブジェクトである必要があります。" });
  }

  return result;
}

/**
 * 壊れた設定ファイルを証拠として隔離する。元ファイルは削除も変更もしない。
 *
 * 隔離先には本体のコピーと、SHA-256 / サイズ / 更新時刻 / 検出した問題を
 * 書いた .meta.json を並べて置く。後から「何がどう壊れていたか」を辿れる。
 */
export function quarantineConfigFile(filePath, { quarantineDir, issues = [], reason = "" } = {}) {
  const dir = quarantineDir || path.join(path.dirname(filePath), "quarantine");
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.basename(filePath);
  const copyPath = path.join(dir, `${base}.${stamp}.corrupt`);
  const metaPath = `${copyPath}.meta.json`;

  // copyFileSync はコピーであって移動ではない。元ファイルはそのまま残る。
  fs.copyFileSync(filePath, copyPath);

  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch {
    /* 取れなくても隔離自体は成立している */
  }

  const meta = {
    quarantinedAt: new Date().toISOString(),
    originalPath: path.resolve(filePath),
    copyPath: path.resolve(copyPath),
    reason,
    sha256: sha256OfFile(copyPath),
    sizeBytes: stat ? stat.size : null,
    originalModifiedAt: stat ? stat.mtime.toISOString() : null,
    issues,
  };
  writeFileAtomic(metaPath, JSON.stringify(meta, null, 2) + "\n");

  return { copyPath, metaPath, meta };
}

/**
 * テキストを UTF-8 (BOM 無し) で atomic に書く。
 *
 *   1. 同じディレクトリの一時ファイルへ書く
 *   2. fsync してディスクまで届かせる
 *   3. 書いたものを読み直して中身が一致するか確かめる
 *   4. rename で置き換える (Windows でも既存ファイルを置換する)
 *
 * 途中で失敗したら一時ファイルを消すだけで、元のファイルには一切触れない。
 * 「書きかけの設定ファイル」が観測されることが無くなる。
 */
export function writeFileAtomic(filePath, text, { verify = null } = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const buf = Buffer.from(text, "utf8");

  let fd;
  try {
    fd = fs.openSync(tmpPath, "wx");
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  try {
    // 書いた内容をディスクから読み直して検証する。ここを通らないものは置き換えない。
    const readBack = fs.readFileSync(tmpPath);
    if (!readBack.equals(buf)) {
      throw new Error("書き込んだ内容と読み直した内容が一致しません。");
    }
    if (verify) verify(new TextDecoder("utf-8", { fatal: true }).decode(readBack));

    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }

  // ディレクトリエントリも永続化する。Windows ではディレクトリを開けないので無視してよい。
  try {
    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    /* Windows では失敗する。rename 自体は完了しているので問題ない。 */
  }

  return filePath;
}

/**
 * 設定オブジェクトを書き出す。JSON として読み直せることを確かめてから置き換える。
 * 設定を書き出す処理はすべてここを通す (エンコーディングと atomic 性を一箇所に集める)。
 */
export function writeConfigFile(filePath, configObject) {
  const text = JSON.stringify(configObject, null, 2) + "\n";
  return writeFileAtomic(filePath, text, {
    verify: (roundTripped) => {
      const parsed = JSON.parse(roundTripped); // 壊れていればここで例外になる
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("書き出した設定が JSON オブジェクトになっていません。");
      }
      const found = detectMojibake(roundTripped);
      if (found.length) {
        throw new Error(`書き出した設定に文字化けの兆候があります: ${found[0].message}`);
      }
    },
  });
}

/**
 * 壊れた設定テキストから $comment ブロックだけを取り除く。
 *
 * 今回の壊れ方は $comment の日本語に閉じており、引用符と改行が壊れているせいで
 * 中括弧の対応も当てにならない。そこで整形済み JSON の見た目 (2 スペース字下げ)
 * を手掛かりに、$comment の行から次の最上位キーの行までを行単位で落とす。
 * 落とした結果が JSON として読めれば、ユーザー設定は 1 つも失わずに復元できる。
 */
export function stripCommentBlock(text) {
  const lines = text.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => /^\s*"\$comment"\s*:/.test(line));
  if (startIndex < 0) return { changed: false, text };

  // $comment の行と同じ字下げで始まる次のキー、または閉じ括弧までを削除範囲とする。
  const indent = /^(\s*)/.exec(lines[startIndex])[1];
  const nextKeyRe = new RegExp(`^${indent}"(?!\\$)[^"]*"\\s*:`);
  const closeRe = new RegExp(`^${indent.slice(0, -2)}}`);

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (nextKeyRe.test(lines[i]) || closeRe.test(lines[i])) {
      endIndex = i;
      break;
    }
  }

  const kept = [...lines.slice(0, startIndex), ...lines.slice(endIndex)];
  return { changed: true, text: kept.join("\n") };
}

/**
 * 壊れた設定を、ユーザー設定を失わない範囲で救出する。
 *
 * 方針は「勝手に既定値へ戻さない」こと。救出できたかどうかを必ず呼び出し側へ返し、
 * 救出できなければ既定値で動かすのではなく診断モードへ倒す。
 */
export function salvageConfigText(text) {
  // そのまま読めるなら救出は不要。
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const issues = detectMojibake(text);
      if (issues.length === 0) return { salvaged: false, reason: "already_valid", config: parsed };
      // JSON としては読めるが文字化けしている → メタキーを落とせば実害が消える。
      const clean = { ...parsed };
      for (const key of Object.keys(clean)) {
        if (key.startsWith("$")) delete clean[key];
      }
      const rest = JSON.stringify(clean);
      if (detectMojibake(rest).length === 0) {
        return { salvaged: true, reason: "dropped_meta_keys", config: clean };
      }
      return { salvaged: false, reason: "mojibake_outside_comment", config: null };
    }
  } catch {
    /* 読めないので下の救出へ進む */
  }

  const stripped = stripCommentBlock(text);
  if (stripped.changed) {
    try {
      const parsed = JSON.parse(stripped.text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (detectMojibake(stripped.text).length === 0) {
          return { salvaged: true, reason: "stripped_comment_block", config: parsed };
        }
        return { salvaged: false, reason: "mojibake_outside_comment", config: null };
      }
    } catch {
      /* $comment 以外も壊れている */
    }
  }

  return { salvaged: false, reason: "unsalvageable", config: null };
}
