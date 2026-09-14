/**
 * [撤去済み・検証対象なし] 2026-09-14指示書「Mercariは商品情報・文章・
 * 画像の準備と手動出品支援を基本とする」対応でMercari Shops APIとの
 * 直接連携(lib/listing/mercari/{client,errors,connectionPolicy,adapter,
 * relay,queries,endpoints,tokenAccess}.ts)を撤去したため、このスクリプト
 * が固定していたHTTPエラー分類・保存可否判定(connectionPolicy)・中継
 * (relay)認証の純ロジック検証は、対応する実装が存在せず検証しようがない。
 *
 * Run with: npm run verify:mercari (no-op — 撤去済みのため何も検証しない)
 */
console.log("verify-mercari.ts: 撤去済み・検証対象なし(Mercari Shops API出品機能を2026-09-14に撤去したため、対応する実装が無い)");
console.log("\n0 passed, 0 failed");
