/**
 * Staging 自動ログイン基盤の検証(**認証情報もブラウザも要らない**)。
 *
 * 実機ログインは資格情報の登録待ちだが、その周辺の分岐 —— 未登録・
 * 壊れた保存状態・空ファイル・不正JSON・秘密の伏字・保存先 —— は
 * すべてここで自動検証できる。「登録が済むまで何も確かめられない」
 * 状態にしない。
 *
 * Run with: npm run verify:staging-auth
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactSecrets, REGISTER_COMMAND, MissingStagingCredentialError } from "@/e2e/auth/credentialStore";
import {
  STORAGE_STATE_FILE,
  inspectStorageState,
  isOutsideRepository,
  isStorageStateUsable,
  removeStorageState,
  writeStorageStateAtomic,
} from "@/e2e/auth/storageStateFile";

let failures = 0;
let passes = 0;
function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ FAIL ${label}\n    expected: ${e}\n    actual:   ${a}`);
  } else {
    passes++;
    console.log(`✓ ${label}`);
  }
}
function assertTrue(cond: boolean, label: string) {
  assertEqual(cond, true, label);
}

/** 検査用の一時ディレクトリ。実際の保存先には触れない。 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bello-auth-test-"));
const tmpFile = (name: string) => path.join(TMP, name);

/* ══════════════════════════════════════════════════════════════════
 * 1. 秘密を出さない
 * ══════════════════════════════════════════════════════════════════ */
function testRedaction() {
  const pw = "S3cret-Passw0rd!";
  assertEqual(redactSecrets(`login failed for ${pw}`, [pw]), "login failed for ********", "伏字: パスワードを置き換える");
  assertEqual(
    redactSecrets(`a ${pw} b ${pw} c`, [pw]),
    "a ******** b ******** c",
    "伏字: 複数箇所すべてを置き換える",
  );
  assertEqual(redactSecrets("no secret here", [pw]), "no secret here", "伏字: 含まなければそのまま");
  assertEqual(redactSecrets("text", [null, undefined, ""]), "text", "伏字: null/undefined/空でも壊れない");
  // 短すぎる文字列で伏字すると、無関係な部分まで潰れて読めなくなる。
  assertEqual(redactSecrets("abc def", ["ab"]), "abc def", "伏字: 3文字以下は対象にしない(誤爆防止)");
  assertEqual(redactSecrets("xxxxabcd", ["abcd"]), "xxxx********", "伏字: 4文字以上は対象になる");

  // 未登録エラーの文面にパスワードが出る余地が無いこと。
  const err = new MissingStagingCredentialError();
  assertTrue(err.message.includes(REGISTER_COMMAND), "未登録エラー: 次にやるコマンドを示す");
  assertTrue(!/pass(word)?\s*[:=]/i.test(err.message), "未登録エラー: パスワードらしき記述を含まない");
}

/* ══════════════════════════════════════════════════════════════════
 * 2. storageState の状態判定
 * ══════════════════════════════════════════════════════════════════ */
function testStorageStateInspection() {
  const missing = tmpFile("missing.json");
  assertEqual(inspectStorageState(missing).kind, "missing", "保存状態: 無ければ missing");
  assertTrue(!isStorageStateUsable(missing), "保存状態: 無ければ使えない");

  const empty = tmpFile("empty.json");
  fs.writeFileSync(empty, "");
  assertEqual(inspectStorageState(empty).kind, "invalid", "保存状態: 空ファイルは invalid");

  const broken = tmpFile("broken.json");
  fs.writeFileSync(broken, '{"cookies":[{"name":"a"');
  assertEqual(inspectStorageState(broken).kind, "invalid", "保存状態: 途中で切れたJSONは invalid");

  const array = tmpFile("array.json");
  fs.writeFileSync(array, "[1,2,3]");
  assertEqual(inspectStorageState(array).kind, "invalid", "保存状態: 配列は invalid");

  const noArrays = tmpFile("shape.json");
  fs.writeFileSync(noArrays, '{"cookies":"nope","origins":{}}');
  assertEqual(inspectStorageState(noArrays).kind, "invalid", "保存状態: cookies/origins が配列でなければ invalid");

  // サインアウト後の空の状態。使えばログイン画面へ飛ぶだけなので、
  // 先に「使えない」と判定して再ログインへ回す。
  const signedOut = tmpFile("signedout.json");
  fs.writeFileSync(signedOut, JSON.stringify({ cookies: [], origins: [] }));
  assertEqual(inspectStorageState(signedOut).kind, "invalid", "保存状態: Cookieもストレージも空なら使えない扱い");

  const emptyLocalStorage = tmpFile("emptyls.json");
  fs.writeFileSync(emptyLocalStorage, JSON.stringify({ cookies: [], origins: [{ origin: "https://x", localStorage: [] }] }));
  assertEqual(inspectStorageState(emptyLocalStorage).kind, "invalid", "保存状態: localStorage が空でも使えない扱い");

  const ok = tmpFile("ok.json");
  fs.writeFileSync(
    ok,
    JSON.stringify({
      cookies: [{ name: "CognitoIdentityServiceProvider.x", value: "TOKEN", domain: "example", path: "/" }],
      origins: [{ origin: "https://example", localStorage: [{ name: "k", value: "v" }] }],
    }),
  );
  const okStatus = inspectStorageState(ok);
  assertEqual(okStatus.kind, "ok", "保存状態: 形が正しければ ok");
  if (okStatus.kind === "ok") {
    assertEqual(okStatus.cookieCount, 1, "保存状態: Cookie件数を返す");
    assertEqual(okStatus.originCount, 1, "保存状態: origin件数を返す");
  }

  // ★ 検査結果に**値そのもの**が入っていないこと。
  //   うっかりログへ出してもトークンが漏れないようにするため。
  assertTrue(!JSON.stringify(okStatus).includes("TOKEN"), "保存状態: 検査結果にトークンの値が入らない");
  assertTrue(!JSON.stringify(okStatus).includes("Cognito"), "保存状態: 検査結果にCookie名も入らない");
}

/* ══════════════════════════════════════════════════════════════════
 * 3. atomic write と後片付け
 * ══════════════════════════════════════════════════════════════════ */
function testAtomicWriteAndCleanup() {
  const file = tmpFile("atomic/state.json");
  const payload = JSON.stringify({ cookies: [{ name: "c", value: "v" }], origins: [] });

  writeStorageStateAtomic(payload, file);
  assertTrue(fs.existsSync(file), "atomic書き込み: ファイルができる");
  assertEqual(fs.readFileSync(file, "utf8"), payload, "atomic書き込み: 中身が一致する");

  // 一時ファイルが残っていないこと(認証情報を含む残骸を置き去りにしない)。
  const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith(".tmp"));
  assertEqual(leftovers, [], "atomic書き込み: 一時ファイルを残さない");

  // 上書きしても壊れない。
  const payload2 = JSON.stringify({ cookies: [{ name: "c2", value: "v2" }], origins: [] });
  writeStorageStateAtomic(payload2, file);
  assertEqual(fs.readFileSync(file, "utf8"), payload2, "atomic書き込み: 上書きできる");

  // 権限(POSIXのみ意味を持つ)。Windowsでは 0o666 に丸められるので検査しない。
  if (process.platform !== "win32") {
    const mode = fs.statSync(file).mode & 0o777;
    assertEqual(mode, 0o600, "atomic書き込み: 所有者のみに絞る(POSIX)");
  } else {
    passes++;
    console.log("✓ atomic書き込み: 権限検査はWindowsでは対象外(mode指定は行っている)");
  }

  // 削除で本体も一時ファイルも消えること。
  fs.writeFileSync(path.join(path.dirname(file), ".state.json.999.tmp"), "leftover");
  removeStorageState(file);
  assertTrue(!fs.existsSync(file), "削除: 保存状態が消える");
  assertEqual(
    fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith(".tmp")),
    [],
    "削除: 書き込み途中の一時ファイルも消える",
  );
  // 無い状態でもう一度呼んでも落ちない。
  removeStorageState(file);
  passes++;
  console.log("✓ 削除: 存在しなくても例外にならない");
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 保存先がリポジトリの外にある
 * ══════════════════════════════════════════════════════════════════ */
function testStorageLocation() {
  const repoRoot = process.cwd();
  assertTrue(
    isOutsideRepository(repoRoot, STORAGE_STATE_FILE),
    `保存先がリポジトリ外にある(${STORAGE_STATE_FILE})`,
  );
  assertTrue(
    !isOutsideRepository(repoRoot, path.join(repoRoot, "e2e", "state.json")),
    "判定そのもの: リポジトリ内のパスは「外」と判定しない",
  );

  // .gitignore にも保険がかかっていること(保存先を変えた誰かのために)。
  const gitignore = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
  assertTrue(gitignore.includes("storage-state"), ".gitignore にも storageState の保険がある");
  assertTrue(gitignore.includes("/test-results/"), ".gitignore に test-results がある(traceに秘密が入りうる)");
  assertTrue(gitignore.includes("/playwright-report/"), ".gitignore に playwright-report がある");
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 資格情報の扱い(静的な検査)
 * ══════════════════════════════════════════════════════════════════ */
function testCredentialHandlingSource() {
  const root = process.cwd();
  const psDir = path.join(root, "tools", "staging-auth");

  // PowerShell スクリプトが ASCII のみであること。
  // 日本語WindowsのPS 5.1はBOM無し.ps1をANSIで読むため、非ASCIIが1文字でも
  // あるとパーサが死ぬ(実際に一度踏んでいる)。
  for (const name of fs.readdirSync(psDir).filter((n) => n.endsWith(".ps1") || n.endsWith(".psm1"))) {
    const body = fs.readFileSync(path.join(psDir, name), "latin1");
    // eslint-disable-next-line no-control-regex
    assertTrue(!/[^\x00-\x7F]/.test(body), `${name}: ASCIIのみ(PS5.1の文字化け対策)`);
  }

  // パスワードがコマンドライン引数として渡される書き方が無いこと。
  // 説明用のブロックコメント(<# ... #>)を落としてから検査する。
  // 「なぜ Read-Host -AsSecureString を使わないか」をコメントで説明して
  // いるので、素朴な文字列検索だと自分の説明文に引っかかる。
  const stripPsComments = (s: string) =>
    s
      // <# ... #> のブロックコメント
      .replace(new RegExp(String.raw`<#[\s\S]*?#>`, "g"), "")
      // 行頭の # コメント
      .replace(new RegExp(String.raw`^[ \t]*#[^\r\n]*`, "gm"), "");

  const setScript = stripPsComments(fs.readFileSync(path.join(psDir, "Set-BelloStagingCredential.ps1"), "utf8"));
  assertTrue(!/-Password\s+["']/.test(setScript), "登録スクリプト: パスワードをリテラル引数で渡していない");
  assertTrue(
    setScript.includes("Get-Credential"),
    "登録スクリプト: Get-Credential を使う(コンソールが無くても無限待機しない)",
  );
  assertTrue(
    !new RegExp(String.raw`Read-Host[^\n]*-AsSecureString`).test(setScript),
    "登録スクリプト: 無限待機する Read-Host -AsSecureString を実際には使っていない",
  );
  assertTrue(setScript.includes("Get-BelloCredential"), "登録スクリプト: 書いた後に読み戻して照合する");

  // 読み出しスクリプトは JSON を1行だけ返す。ログ出力を持たない。
  const getScript = stripPsComments(fs.readFileSync(path.join(psDir, "Get-BelloStagingCredential.ps1"), "utf8"));
  assertTrue(!/Write-Host/.test(getScript), "読み出しスクリプト: Write-Host を持たない(値が端末へ出ない)");
  assertTrue(getScript.includes("ConvertTo-Json"), "読み出しスクリプト: JSONで返す");

  // 状態確認スクリプトは値を出さない。
  const testScript = stripPsComments(fs.readFileSync(path.join(psDir, "Test-BelloStagingCredential.ps1"), "utf8"));
  assertTrue(
    !/\$cred\.Password\s*\)/.test(testScript.replace(/\$cred\.Password\.Length/g, "")),
    "状態確認スクリプト: パスワードの値そのものを表示しない",
  );
  assertTrue(testScript.includes(".Password.Length"), "状態確認スクリプト: 文字数だけを出す");

  // モジュールがメモリをゼロ化していること。
  const module = fs.readFileSync(path.join(psDir, "BelloCredential.psm1"), "utf8");
  assertTrue(module.includes("ZeroFreeBSTR"), "モジュール: BSTRをゼロ化して解放する");
  assertTrue(module.includes("FreeHGlobal"), "モジュール: アンマネージドメモリを解放する");
  assertTrue(module.includes("[Array]::Clear"), "モジュール: マネージドのバイト配列もクリアする");
  assertTrue(module.includes("CredFree"), "モジュール: CredRead のバッファを解放する");

  // Node側: PowerShell の stderr を例外へ連鎖させていないこと。
  const store = fs.readFileSync(path.join(root, "e2e", "auth", "credentialStore.ts"), "utf8");
  assertTrue(!/cause:\s*err/.test(store), "読み出しヘルパー: 元エラーを連鎖させない(stderrに秘密が乗る経路を作らない)");
  assertTrue(store.includes("windowsHide: true"), "読み出しヘルパー: コンソール窓を出さない");

  // ログインは trace 対象のテスト context では行わない。
  const auth = fs.readFileSync(path.join(root, "e2e", "auth", "stagingAuth.ts"), "utf8");
  assertTrue(auth.includes("chromium.launch"), "ログイン: 独自に起動したブラウザで行う(traceに残らない)");
  const specs = path.join(root, "e2e", "staging");
  for (const name of fs.existsSync(specs) ? fs.readdirSync(specs).filter((n) => n.endsWith(".spec.ts")) : []) {
    const body = fs.readFileSync(path.join(specs, name), "utf8");
    assertTrue(
      !/input\[type="password"\]'\s*\)\s*\.fill\(/.test(body),
      `${name}: テスト本体でパスワード欄へ入力していない(traceに値が残らない)`,
    );
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 6. Playwright 設定
 * ══════════════════════════════════════════════════════════════════ */
function testPlaywrightConfig() {
  const config = fs.readFileSync(path.join(process.cwd(), "playwright.staging.config.ts"), "utf8");
  assertTrue(config.includes('screenshot: "only-on-failure"'), "設定: スクリーンショットは失敗時のみ");
  assertTrue(config.includes('video: "off"'), "設定: 動画は保存しない");
  assertTrue(config.includes("globalSetup"), "設定: globalSetup で認証を用意する");
  assertTrue(config.includes("storageState"), "設定: 各テストは保存済みの状態から始まる");
  assertTrue(config.includes("workers: 1"), "設定: 実データを触るので直列実行");
}

function main() {
  try {
    testRedaction();
    testStorageStateInspection();
    testAtomicWriteAndCleanup();
    testStorageLocation();
    testCredentialHandlingSource();
    testPlaywrightConfig();
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
