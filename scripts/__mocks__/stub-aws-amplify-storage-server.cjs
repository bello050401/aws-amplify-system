// scripts/verify-listings-overview-service-boundary.ts 専用スタブ。
// lib/listing/mercari/adapter.ts が`import { getUrl } from
// "aws-amplify/storage/server"`するが、この検証は画像URL解決を伴う
// 出品経路を一切呼ばない——モジュール解決を通すためだけの空実装。
module.exports = {
  getUrl: () => {
    throw new Error("[stub-aws-amplify-storage-server] getUrl() was called but this test never expects it to run");
  },
};
