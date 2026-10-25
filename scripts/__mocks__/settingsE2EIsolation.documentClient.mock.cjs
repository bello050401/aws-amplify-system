// Construction is local. Only send() is the external boundary and must be counted.
const calls = [];
class Command { constructor(input) { this.input = input; } }
module.exports = {
  __calls: calls, __resetCalls() { calls.length = 0; },
  DynamoDBDocumentClient: { from() { return { async send(command) { calls.push(command.input); throw new Error('Unexpected direct DynamoDB call in settings fixture'); } }; } },
  GetCommand: Command, PutCommand: Command, UpdateCommand: Command, DeleteCommand: Command,
  QueryCommand: Command, ScanCommand: Command, BatchGetCommand: Command, BatchWriteCommand: Command, TransactWriteCommand: Command,
};
