/**
 * scripts/verify-zaico-sync-e2e-isolation.ts 専用。lib/inventory/
 * zaicoSyncE2eFixtures.tsが読む`cookies().get("__inv_e2e_zaico_scenario")`
 * を、テスト側から`__setScenarioCookie`で自由に切り替えられるようにする
 * (Playwright実行時のCookieに相当するものを、この単体境界試験では
 * 直接差し込む)。
 */
let scenarioValue;

function __setScenarioCookie(value) {
  scenarioValue = value;
}

function cookies() {
  return {
    get(name) {
      if (name !== "__inv_e2e_zaico_scenario") return undefined;
      return scenarioValue === undefined ? undefined : { name, value: scenarioValue };
    },
  };
}

module.exports = { __setScenarioCookie, cookies };
