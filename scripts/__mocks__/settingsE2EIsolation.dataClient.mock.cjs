// scripts/verify-settings-e2e-isolation.ts 専用スタブ。
//
// 設定画面(app/inventory/(protected)/settings/page.tsx)が呼ぶ関数群
// (ensureSettingsBootstrap/listAllMasterEntries/listAllCustomFieldDefinitions
// /getZaicoTokenSource/getLineTokenSource/getMercariConnectionState/
// getBaseConnectionState)は、isE2EFixtureModeActive()がtrueの間は
// serverDataClient(AppSync)に一切触れてはいけない —— 触れたことを
// 「例外を投げて検出する」だけでなく「実際に呼ばれたかどうかを記録する」
// ことで、内部でtry/catchして例外を握りつぶす経路(例:
// lib/inventory/settingsBootstrap.tsのensureSettingsBootstrapは失敗を
// 常にconsole.errorへ握りつぶし、呼び出し元へは投げない)でも見逃さない。
//
// modelプロパティ名・メソッド名を問わず、どの`serverDataClient.models.X.y()`
// 呼び出しも記録した上でthrowする(Proxyで動的に生成 — 実際に呼ばれた
// model/opの組み合わせだけが記録に残る)。
const calls = [];

function makeThrowingModels() {
  return new Proxy(
    {},
    {
      get(_target, modelProp) {
        return new Proxy(
          {},
          {
            get(_t2, methodProp) {
              return (...args) => {
                const entry = { model: String(modelProp), op: String(methodProp) };
                calls.push(entry);
                throw new Error(
                  `[settingsE2EIsolation] serverDataClient.models.${entry.model}.${entry.op}() was called — fixture mode must never reach AppSync/DynamoDB`,
                );
              };
            },
          },
        );
      },
    },
  );
}

module.exports = {
  serverDataClient: { models: makeThrowingModels() },
  inventoryAuthMode: { authMode: "userPool" },
  adminAuthMode: { authMode: "userPool" },
  runWithDirectData: (fn) => fn(),
  isDevDirectDataEnabled: () => false,
  isDirectDataMode: () => false,
  __calls: calls,
  __resetCalls: () => {
    calls.length = 0;
  },
};
