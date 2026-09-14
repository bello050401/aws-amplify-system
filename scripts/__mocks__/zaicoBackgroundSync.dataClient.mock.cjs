/**
 * scripts/verify-zaico-retry-persistence.ts 専用fixture(task_9c59e22b1e26721377)。
 *
 * lib/inventory/zaicoBackgroundSync.ts が直接呼ぶ lib/amplify/dataClient.ts の
 * `serverDataClient`/`inventoryAuthMode`だけを差し替える
 * (scripts/__mocks__/inventoryHistory.dataClient.mock.cjs と同じ設計・同じ理由
 * ——本物のserverDataClientはCookie認証+amplify_outputs.jsonをモジュール
 * 読込時にimportするため、この worktree ではそのまま使えない)。
 *
 * ZaicoSyncJobの単一行(singleton)をin-memoryで模す。start/advance両方の
 * 実関数(startZaicoBackgroundSyncJob/advanceZaicoBackgroundSyncJob)が
 * 実際に発行する.get/.create/.updateだけをサポートする——汎用モックでは
 * ない。Inventory.listはfindMissingZaicoManagedInventory(isDone到達時
 * のみ呼ばれる)向けに、常に空ページを返す最小実装。
 *
 * .cjs にしている理由も同じ(salesAggregateStore/inventoryHistory版の
 * コメント参照): tsxがCJS出力するzaicoBackgroundSync.tsから.mjsを
 * requireするとModule._cacheが分裂し、テスト側の__setJobRow等の操作が
 * 実際に参照されるインスタンスへ反映されない。
 */

let jobRow = null; // null = テーブルに行が無い(初回start前)
const updateLog = [];
let updateRejection = null; // 次回.update()だけ{errors:[...]}を返す(開始書込失敗シナリオ用)

function __setJobRow(row) {
  jobRow = row ? { ...row } : null;
  updateLog.length = 0;
}

function __getJobRow() {
  return jobRow ? { ...jobRow } : null;
}

function __getUpdateLog() {
  return updateLog.map((r) => ({ ...r }));
}

/** 次の1回の.update()呼び出しだけ{data:null, errors:[...]}を返す——書き込み自体は起きない(jobRowは変わらない)。 */
function __rejectNextUpdate(message) {
  updateRejection = message ?? "書き込みエラー(テスト用)";
}

const inventoryAuthMode = { authMode: "userPool" };

const serverDataClient = {
  models: {
    ZaicoSyncJob: {
      async get({ id }) {
        if (!jobRow || jobRow.id !== id) return { data: null };
        return { data: { ...jobRow } };
      },
      async create(fields) {
        jobRow = { ...fields };
        updateLog.push({ ...jobRow });
        return { data: { ...jobRow } };
      },
      async update(fields) {
        if (updateRejection) {
          const message = updateRejection;
          updateRejection = null;
          return { data: null, errors: [{ message }] };
        }
        if (!jobRow) return { data: null, errors: [{ message: "no such row" }] };
        jobRow = { ...jobRow, ...fields };
        updateLog.push({ ...jobRow });
        return { data: { ...jobRow } };
      },
    },
    Inventory: {
      // findMissingZaicoManagedInventory向け——このテストではZAICO連携
      // 在庫の突き合わせ自体は対象外なので、常に空ページを返す。
      async list(_args) {
        return { data: [], nextToken: undefined };
      },
    },
  },
};

module.exports = {
  __setJobRow,
  __getJobRow,
  __getUpdateLog,
  __rejectNextUpdate,
  inventoryAuthMode,
  serverDataClient,
};
