// scripts/verify-listings-overview-service-boundary.ts 専用スタブ。
// lib/inventory/{inventorySearchFast,inventoryCountFast}.ts・
// lib/amplify/directData.ts が直接DynamoDBを叩く高速経路
// (searchInventoryFast等)で使うが、この検証(listListingsOverview)は
// その経路を一切呼ばない——モジュール解決を通すためだけの空実装。
class StubDynamoDBClient {}
module.exports = { DynamoDBClient: StubDynamoDBClient };
