/**
 * scripts/verify-sales-summary-e2e-isolation.ts 専用fixture(売上予測
 * 候補b2b385fのQA境界試験)。
 *
 * scripts/__mocks__/zaicoSyncE2EIsolation.dataClient.mock.cjsと同じ発想
 * ——実SDK(serverDataClient)へ到達したかどうかだけを`__calls`へ記録する。
 */
let snapshotRow = null;
const calls = [];

function __resetCalls() {
  calls.length = 0;
}

function __setSnapshotRow(row) {
  snapshotRow = row ? { ...row } : null;
}

const inventoryAuthMode = { authMode: "userPool" };

const serverDataClient = {
  models: {
    SalesAggregateSnapshot: {
      async get({ id }) {
        calls.push({ model: "SalesAggregateSnapshot", op: "get", id });
        if (!snapshotRow || snapshotRow.id !== id) return { data: null };
        return { data: { ...snapshotRow } };
      },
    },
  },
};

module.exports = {
  __resetCalls,
  __setSnapshotRow,
  __calls: calls,
  inventoryAuthMode,
  serverDataClient,
};
