// scripts/verify-listings-overview-service-boundary.ts 専用スタブ。
// stub-aws-sdk-dynamodb.cjsと同じ理由(直接DynamoDB経路はこの検証が
// 一切呼ばない)。DynamoDBDocumentClient.from()を呼ぶ箇所があるので
// staticメソッドも用意しておく(呼ばれたらthrowする)。
class StubDynamoDBDocumentClient {
  static from() {
    throw new Error("[stub-aws-sdk-lib-dynamodb] DynamoDBDocumentClient.from() was called but this test never expects it to run");
  }
}
class StubCommand {
  constructor(input) {
    this.input = input;
  }
}
module.exports = {
  DynamoDBDocumentClient: StubDynamoDBDocumentClient,
  GetCommand: StubCommand,
  PutCommand: StubCommand,
  UpdateCommand: StubCommand,
  DeleteCommand: StubCommand,
  ScanCommand: StubCommand,
  QueryCommand: StubCommand,
};
