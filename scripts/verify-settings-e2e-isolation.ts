/**
 * 前回審査の主目的: 設定画面(app/inventory/(protected)/settings)の
 * Playwright E2E(fixtureモード)が、AWS Secrets Manager/DynamoDB(AppSync)
 * 等の実外部へ一切到達しないことをSDK境界のspy/throwで実証する。
 *
 * scripts/verify-listings-overview-service-boundary.tsと同じ設計
 * (registerHooksでモジュール解決を差し替える、対象関数自体は実物の
 * ままimportする)。実行にtsxが要る理由も同じ(constructor parameter
 * property構文を持つ依存(lib/integrations/writeGuard.ts)がNode単体の
 * strip-onlyモードでは非対応)。
 *
 * 検証する関数(すべて設定画面page.tsxが実際に呼ぶもの):
 *   - lib/inventory/settingsBootstrap.ts の ensureSettingsBootstrap
 *   - lib/inventory/masters.ts の listAllMasterEntries
 *   - lib/inventory/queries.ts の listAllCustomFieldDefinitions
 *   - lib/zaico/client.ts の getZaicoTokenSource
 *   - lib/messaging/line/tokenAccess.ts の getLineTokenSource
 *   - lib/listing/mercari/tokenAccess.ts の getMercariConnectionState
 *   - lib/base/connectionState.ts の getBaseConnectionState
 *
 * 各関数は「fixtureモードON」で1回、「fixtureモードOFF(比較対照)」で
 * 1回ずつ呼ぶ —— OFFの実行でSDK境界(SecretsManagerClient.send /
 * serverDataClient.models.*.*())が実際に叩かれることを先に確認して
 * 初めて、ON側で叩かれていないことの検証に意味が生まれる(叩かれる
 * 経路自体が無いスタブなら、ONでもOFFでも0のままになり得るため)。
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

declare module "node:module" {
  export function registerHooks(hooks: {
    resolve?: (
      specifier: string,
      context: { parentURL?: string },
      nextResolve: (specifier: string, context: unknown) => unknown,
    ) => unknown;
  }): void;
}

const projectRoot = pathToFileURL(process.cwd() + "/").href;
const mocksDir = pathToFileURL(process.cwd() + "/scripts/__mocks__/").href;
const DATA_CLIENT_MOCK_URL = mocksDir + "settingsE2EIsolation.dataClient.mock.cjs";
const SECRETS_MANAGER_MOCK_URL = mocksDir + "settingsE2EIsolation.secretsManager.mock.cjs";

// lib/inventory/settingsBootstrap.tsが(fixture OFF経路で)引き込む
// lib/shipping/service.ts → lib/listing/service.tsの依存グラフは、
// scripts/verify-listings-overview-service-boundary.tsが既に洗い出した
// ものと同一 —— 同じスタブ一式を再利用する(重複調査をしない)。
const EXTERNAL_STUBS: Record<string, string> = {
  "server-only": mocksDir + "stub-server-only.cjs",
  "next/headers": mocksDir + "stub-next-headers.cjs",
  "aws-amplify/storage/server": mocksDir + "stub-aws-amplify-storage-server.cjs",
  "@aws-sdk/client-secrets-manager": SECRETS_MANAGER_MOCK_URL,
  react: mocksDir + "stub-react-minimal.cjs",
  "@aws-sdk/client-dynamodb": mocksDir + "stub-aws-sdk-dynamodb.cjs",
  "@aws-sdk/lib-dynamodb": mocksDir + "stub-aws-sdk-lib-dynamodb.cjs",
  "@aws-amplify/adapter-nextjs": mocksDir + "stub-amplify-adapter-nextjs.cjs",
  "@/amplify_outputs.json": mocksDir + "stub-amplify-outputs.cjs",
};

registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === "@/lib/amplify/dataClient") {
      return { url: DATA_CLIENT_MOCK_URL, shortCircuit: true };
    }
    if (specifier in EXTERNAL_STUBS) {
      return { url: EXTERNAL_STUBS[specifier], shortCircuit: true };
    }
    const isAlias = specifier.startsWith("@/");
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    if (!isAlias && !isRelative) {
      return nextResolve(specifier, context);
    }
    const target = isAlias ? projectRoot + specifier.slice(2) : specifier;
    try {
      return nextResolve(target, context);
    } catch {
      try {
        return nextResolve(target + ".ts", context);
      } catch {
        return nextResolve(target + ".tsx", context);
      }
    }
  },
});

let passes = 0;
let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) {
    passes++;
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`✗ FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const dataClientMock = (await import(DATA_CLIENT_MOCK_URL)).default;
  const secretsManagerMock = (await import(SECRETS_MANAGER_MOCK_URL)).default;

  function resetSpies() {
    dataClientMock.__resetCalls();
    secretsManagerMock.__resetCalls();
  }
  function totalCalls() {
    return dataClientMock.__calls.length + secretsManagerMock.__calls.length;
  }

  const { ensureSettingsBootstrap } = await import("@/lib/inventory/settingsBootstrap");
  const { listAllMasterEntries } = await import("@/lib/inventory/masters");
  const { listAllCustomFieldDefinitions } = await import("@/lib/inventory/queries");
  const { getZaicoTokenSource } = await import("@/lib/zaico/client");
  const { getLineTokenSource } = await import("@/lib/messaging/line/tokenAccess");
  const { getMercariConnectionState } = await import("@/lib/listing/mercari/tokenAccess");
  const { getBaseConnectionState } = await import("@/lib/base/connectionState");

  const originalFixtureFlag = process.env.INVENTORY_E2E_FIXTURES;
  // isE2EFixtureModeActive()はNODE_ENV!=="production"も要求する。@types/node
  // はNODE_ENVをreadonlyとして扱うため代入はできない(TS2540) — tsx実行時に
  // 既に"production"でないことをここで確かめ、もし"production"のまま
  // 実行された場合は「fixture ON側のcheckが全部no-op(=常に成功したように
  // 見える)」という誤検出を招くため、その場で明示的に落とす。
  if (process.env.NODE_ENV === "production") {
    throw new Error("NODE_ENV=productionでは isE2EFixtureModeActive() が常にfalseになり、このテスト自体が意味を持たない");
  }

  console.log("── 比較対照(fixture OFF): 各関数が実際にSDK境界へ到達することをまず確認 ──");
  {
    delete process.env.INVENTORY_E2E_FIXTURES;

    resetSpies();
    await listAllMasterEntries("Category").catch(() => {});
    check(totalCalls() > 0, "比較対照: fixture OFFでlistAllMasterEntriesはAppSync境界へ到達する(スパイ自体が機能している証拠)", JSON.stringify(dataClientMock.__calls));

    resetSpies();
    await listAllCustomFieldDefinitions().catch(() => {});
    check(totalCalls() > 0, "比較対照: fixture OFFでlistAllCustomFieldDefinitionsはAppSync境界へ到達する");

    resetSpies();
    await getZaicoTokenSource().catch(() => {});
    check(totalCalls() > 0, "比較対照: fixture OFFでgetZaicoTokenSourceはSecrets Manager境界へ到達する(内部でtry/catchされていても__callsで検出できる)");

    resetSpies();
    await getLineTokenSource().catch(() => {});
    check(totalCalls() > 0, "比較対照: fixture OFFでgetLineTokenSourceはSecrets Manager境界へ到達する");

    resetSpies();
    await getMercariConnectionState().catch(() => {});
    check(totalCalls() > 0, "比較対照: fixture OFFでgetMercariConnectionStateはSecrets Manager境界へ到達する");

    resetSpies();
    await getBaseConnectionState("example.com").catch(() => {});
    check(totalCalls() > 0, "比較対照: fixture OFFでgetBaseConnectionStateはSecrets Manager/AppSync境界へ到達する");
  }

  console.log("\n── 本題(fixture ON): 設定画面が実際に呼ぶ全関数がSDK境界へ一度も到達しない ──");
  {
    process.env.INVENTORY_E2E_FIXTURES = "1";

    resetSpies();
    await ensureSettingsBootstrap();
    check(totalCalls() === 0, "★要件: fixture ONでensureSettingsBootstrapはAppSyncへ一切到達しない(dedupe/seed系を丸ごとskip)", JSON.stringify([...dataClientMock.__calls, ...secretsManagerMock.__calls]));

    resetSpies();
    const categories = await listAllMasterEntries("Category");
    const locations = await listAllMasterEntries("Location");
    const units = await listAllMasterEntries("Unit");
    const statuses = await listAllMasterEntries("Status");
    check(totalCalls() === 0, "★要件: fixture ONでlistAllMasterEntries(全model)はAppSyncへ一切到達しない");
    check(categories.length > 0 && locations.length > 0 && units.length > 0 && statuses.length > 0, "listAllMasterEntriesは各modelで合成データを返す(空配列で誤魔化さない)");

    resetSpies();
    const customFields = await listAllCustomFieldDefinitions();
    check(totalCalls() === 0, "★要件: fixture ONでlistAllCustomFieldDefinitionsはAppSyncへ一切到達しない");
    check(Array.isArray(customFields), "listAllCustomFieldDefinitionsは配列を返す");

    resetSpies();
    const zaicoSource = await getZaicoTokenSource();
    check(totalCalls() === 0, "★要件: fixture ONでgetZaicoTokenSourceはSecrets Managerへ一切到達しない");
    check(zaicoSource === "secrets-manager", "getZaicoTokenSourceは合成値を返す(未設定と偽らない)", zaicoSource);

    resetSpies();
    const lineSource = await getLineTokenSource();
    check(totalCalls() === 0, "★要件: fixture ONでgetLineTokenSourceはSecrets Managerへ一切到達しない");
    check(lineSource === "secrets-manager", "getLineTokenSourceは合成値を返す", lineSource);

    resetSpies();
    const mercariState = await getMercariConnectionState();
    check(totalCalls() === 0, "★要件: fixture ONでgetMercariConnectionStateはSecrets Managerへ一切到達しない");
    check(mercariState.tokenSource === "secrets-manager" && mercariState.verification === "verified", "getMercariConnectionStateは「接続済み・検証済み」の合成状態を返す", JSON.stringify(mercariState));
    check(typeof mercariState.writesEnabled === "boolean", "writesEnabledはisExternalWriteEnabled(環境変数のみ、AWSに触れない)由来のまま");

    resetSpies();
    const baseState = await getBaseConnectionState("example.com");
    check(totalCalls() === 0, "★要件: fixture ONでgetBaseConnectionStateはSecrets Manager/AppSyncへ一切到達しない");
    check(baseState.status === "CONNECTED" && baseState.dataSource === "REAL", "getBaseConnectionStateは「接続済み」の合成状態を返す(§9: BASEも実際の接続画面を確認できる)", JSON.stringify(baseState));
  }

  if (originalFixtureFlag === undefined) delete process.env.INVENTORY_E2E_FIXTURES;
  else process.env.INVENTORY_E2E_FIXTURES = originalFixtureFlag;

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
