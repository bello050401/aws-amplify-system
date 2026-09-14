/**
 * [撤去済み・検証対象なし] 2026-09-14指示書「Mercariは商品情報・文章・
 * 画像の準備と手動出品支援を基本とする」対応でMercari Shops APIとの
 * 実接続(lib/listing/mercari/{client,queries,tokenAccess,endpoints,
 * errors}.ts)を撤去したため、このスクリプトが行っていた実エンドポイント
 * への疎通確認は、対応する実装が存在せず実行しようがない。
 *
 * Run with: npm run verify:mercari-live (no-op — 撤去済みのため何も接続しない)
 */
console.log("verify-mercari-live.ts: 撤去済み・検証対象なし(Mercari Shops API出品機能を2026-09-14に撤去したため、実接続する経路が無い)");
console.log("\n0 passed, 0 failed");
