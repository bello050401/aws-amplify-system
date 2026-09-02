import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Staging のログイン情報を Windows 資格情報マネージャーから取り出す。
 *
 * ── どこにも書かない ────────────────────────────────────────────
 *
 * この関数が返した値は、呼び出し側(e2e/auth/stagingLogin.ts)がその場で
 * Playwright のフォームへ入れるためだけに使う。ファイル・ログ・
 * スクリーンショット・エラーメッセージのどれにも出さない。
 *
 * 特に **例外の message へ混ぜない**。PowerShell の stderr をそのまま
 * throw すると、将来スクリプトが引数を出力するようになった日に
 * パスワードがCIログへ流れる。だからここでは stderr を要約した
 * 固定文言だけを投げる。
 *
 * ── なぜ PowerShell を経由するのか ─────────────────────────────
 *
 * Windows 資格情報マネージャーは Win32 API(CredRead)でしか読めない。
 * Node から直接叩くにはネイティブアドオンが要り、依存を1つ増やすことに
 * なる。既にこのリポジトリには Windows 用の PowerShell ツール群があり、
 * 同じ流儀に合わせるほうが持ち物が増えない。
 */

export interface StagingCredential {
  username: string;
  password: string;
}

const READER = path.join(process.cwd(), "tools", "staging-auth", "Get-BelloStagingCredential.ps1");

export const REGISTER_COMMAND =
  "powershell -NoProfile -ExecutionPolicy Bypass -File .\\tools\\staging-auth\\Set-BelloStagingCredential.ps1";

export class MissingStagingCredentialError extends Error {
  constructor() {
    super(
      [
        "Staging のログイン情報が Windows 資格情報マネージャーに登録されていません。",
        "",
        "次のコマンドを1回だけ実行して登録してください(対話でメールアドレスとパスワードを聞きます):",
        `  ${REGISTER_COMMAND}`,
      ].join("\n"),
    );
    this.name = "MissingStagingCredentialError";
  }
}

export async function readStagingCredential(): Promise<StagingCredential> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", READER],
      // 資格情報が大きくなることは無いので、出力上限は小さくてよい。
      { maxBuffer: 64 * 1024, windowsHide: true },
    );
    stdout = result.stdout;
  } catch {
    // 意図的に元のエラーを連鎖させない —— stderr にパスワードが乗る
    // 経路を将来にわたって作らないため。
    throw new Error(
      "Windows 資格情報マネージャーの読み取りに失敗しました。" +
        " tools/staging-auth/Test-BelloStagingCredential.ps1 を実行して状態を確認してください。",
    );
  }

  let parsed: { found?: boolean; username?: string; password?: string };
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error("資格情報の読み取り結果を解釈できませんでした(JSONではありませんでした)。");
  }

  if (!parsed.found) throw new MissingStagingCredentialError();
  if (!parsed.username || !parsed.password) {
    throw new Error("登録されている資格情報にメールアドレスまたはパスワードが入っていません。登録し直してください。");
  }
  return { username: parsed.username, password: parsed.password };
}

/**
 * 例外メッセージ・ログへ出す前に、秘密が混ざっていないかを落とす。
 *
 * 「出さないように気をつける」だけでは、経路が増えたときに必ず1つ漏れる。
 * 出口で機械的に伏せる。
 */
export function redactSecrets(text: string, secrets: (string | undefined | null)[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    out = out.split(s).join("********");
  }
  return out;
}
