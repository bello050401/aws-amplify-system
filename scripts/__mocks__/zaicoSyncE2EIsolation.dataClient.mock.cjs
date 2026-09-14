/**
 * scripts/verify-zaico-sync-e2e-isolation.ts 専用fixture(ZAICO候補3b3b8cd
 * のQA境界試験)。
 *
 * scripts/__mocks__/zaicoBackgroundSync.dataClient.mock.cjs(task_9c59e22b1e26721377
 * 用)と役割が違う——あちらはstart/advanceの「再試行が正しく持ち越されるか」
 * という**機能**試験用で、呼び出し回数を数える設計になっていない。
 * このファイルは逆に機能を一切検証せず、「実SDK境界(serverDataClient)へ
 * 到達したかどうか」だけを`__calls`へ記録する——
 * scripts/__mocks__/settingsE2EIsolation.dataClient.mock.cjsと同じ発想・
 * 同じ`__calls`インターフェース。
 */

let jobRow = null;
const calls = [];

function __resetCalls() {
  calls.length = 0;
}

function __setJobRow(row) {
  jobRow = row ? { ...row } : null;
}

const inventoryAuthMode = { authMode: "userPool" };

const serverDataClient = {
  models: {
    ZaicoSyncJob: {
      async get({ id }) {
        calls.push({ model: "ZaicoSyncJob", op: "get", id });
        if (!jobRow || jobRow.id !== id) return { data: null };
        return { data: { ...jobRow } };
      },
      async create(fields) {
        calls.push({ model: "ZaicoSyncJob", op: "create" });
        jobRow = { ...fields };
        return { data: { ...jobRow } };
      },
      async update(fields) {
        calls.push({ model: "ZaicoSyncJob", op: "update" });
        if (!jobRow) return { data: null, errors: [{ message: "no such row" }] };
        jobRow = { ...jobRow, ...fields };
        return { data: { ...jobRow } };
      },
    },
    Inventory: {
      async list(_args) {
        calls.push({ model: "Inventory", op: "list" });
        return { data: [], nextToken: undefined };
      },
    },
  },
};

module.exports = {
  __resetCalls,
  __setJobRow,
  __calls: calls,
  inventoryAuthMode,
  serverDataClient,
};
