const Base = class {
  constructor(input) { this.input = input; }
};
class ConditionalCheckFailedException extends Error {}
class TransactionCanceledException extends Error {
  constructor(CancellationReasons) { super('mock: transaction canceled'); this.CancellationReasons = CancellationReasons; }
}
class ScanCommand extends Base {}
class GetCommand extends Base {}
class PutCommand extends Base {}
class QueryCommand extends Base {}
class BatchWriteCommand extends Base {}
class TransactWriteCommand extends Base {}
class UpdateCommand extends Base {}
class DeleteCommand extends Base {}
class DynamoDBClient {}

let inventoryItems = [];
let runStatusItem;
let snapshotStorage;
let putBehavior = 'success';
const shards = new Map();
const calls = { snapshotPuts: [], runStatusPuts: [] };

function __configure({ items = [], existingRunStatus, existingSnapshot, snapshotPutBehavior = 'success' } = {}) {
  inventoryItems = items;
  runStatusItem = existingRunStatus;
  snapshotStorage = existingSnapshot;
  putBehavior = snapshotPutBehavior;
  calls.snapshotPuts = [];
  calls.runStatusPuts = [];
  shards.clear();
}

const DynamoDBDocumentClient = { from: () => ({
  async send(command) {
    const { TableName, Key, Item, RequestItems, TransactItems } = command.input;
    if (command instanceof ScanCommand) {
      return { Items: TableName === process.env.INVENTORY_TABLE_NAME ? inventoryItems : [] };
    }
    if (command instanceof QueryCommand) return { Items: [] };
    if (command instanceof GetCommand) {
      if (TableName === process.env.SALES_AGGREGATE_RUN_STATUS_TABLE_NAME) return { Item: runStatusItem };
      if (TableName === process.env.SALES_AGGREGATE_SNAPSHOT_TABLE_NAME && Key.id === 'current') return { Item: snapshotStorage };
      return {};
    }
    if (command instanceof BatchWriteCommand) {
      for (const { PutRequest } of Object.values(RequestItems).flat()) shards.set(PutRequest.Item.id, PutRequest.Item);
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      const current = TransactItems[0].Put.Item;
      calls.snapshotPuts.push(current);
      if (putBehavior === 'conditionalFail') throw new TransactionCanceledException([{ Code: 'ConditionalCheckFailed' }]);
      if (putBehavior === 'otherFail') throw new Error('mock: DynamoDBへの書き込みに失敗しました');
      for (const target of Object.values(JSON.parse(current.analysisManifestJson).targets)) {
        for (const entry of target) if (!entry.hash) throw new Error('mock: shard hash missing');
      }
      snapshotStorage = current;
      return {};
    }
    if (command instanceof PutCommand) {
      if (TableName !== process.env.SALES_AGGREGATE_RUN_STATUS_TABLE_NAME) return {};
      calls.runStatusPuts.push(Item);
      runStatusItem = Item;
      return {};
    }
    throw new Error('mock: 未対応のコマンドです');
  },
}) };
exports.ConditionalCheckFailedException = ConditionalCheckFailedException;
exports.TransactionCanceledException = TransactionCanceledException;
exports.ScanCommand = ScanCommand;
exports.GetCommand = GetCommand;
exports.PutCommand = PutCommand;
exports.QueryCommand = QueryCommand;
exports.BatchWriteCommand = BatchWriteCommand;
exports.TransactWriteCommand = TransactWriteCommand;
exports.UpdateCommand = UpdateCommand;
exports.DeleteCommand = DeleteCommand;
exports.DynamoDBClient = DynamoDBClient;
exports.calls = calls;
exports.__configure = __configure;
exports.DynamoDBDocumentClient = DynamoDBDocumentClient;
exports.__getSnapshotStorage = () => snapshotStorage;
