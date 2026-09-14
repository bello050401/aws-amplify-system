// Mercari Shops API出品機能の撤去(2026-09-14、P1)に伴い、この
// 「自動価格設定」UIは撤去した。
//
// このセクションはMercariチャネルのChannelListingにしか表示されず
// (ListingForm.tsxの旧呼び出し箇所参照)、「今すぐ価格チェックを実行」
// しても実際にMercari側の価格を変更するAPI呼び出しは存在しなかった
// (lib/listing/pricingService.tsのrunPricingCheckは、Mercariチャネルに
// 対しては判定結果をPriceHistoryへ"NOT_IMPLEMENTED"として記録するのみ)。
// ユーザーの指示(§4)「Mercari自動価格変更を装う専用UIも撤去」に基づき、
// 実行してもMercariには反映されないこのUI(および一括適用導線
// PricingRuleAssignForm.tsx/assign/page.tsx)を削除した。
//
// 一般的な価格設定(PricingRuleの作成・一覧: /inventory/listings/
// pricing-rules)とBASEチャネルの自動値下げ実行(lib/listing/
// pricingService.tsのrunPricingCheck、BASEブランチは実際に
// updateBaseProductを呼ぶ)は変更していない。過去に記録された
// PriceHistory/ChannelListing.autoPricingEnabled等のデータも削除して
// いない(読み取り専用の参照は引き続き可能)。
export {};
