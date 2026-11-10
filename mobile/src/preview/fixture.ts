import type { InventoryItem } from "../domain/inventory";
import { DETAIL_FIELDS } from "../domain/detailFields";

// Synthetic records only. Preview changes never call BELLO or marketplace services.
export const previewItems: InventoryItem[] = [
  { id: "preview-chair", sku: "見本001", name: "ダイニングチェア / ナチュラルウッド", quantity: 11, unit: "脚", location: "川越倉庫", category: "販売中", condition: "目立った傷や汚れなし", note: "画面確認用のサンプルです。実在庫ではありません。", barcode: "PREVIEW001", plannedSalePrice: 29800, thumbnailUrl: null, updatedAt: "2026-10-17T01:00:00.000Z" },
  { id: "preview-table", sku: "見本002", name: "ラウンドテーブル / オーク", quantity: 3, unit: "台", location: "所沢倉庫", category: "撮影待ち", condition: "やや傷や汚れあり", note: "天板の状態を確認する", barcode: "PREVIEW002", plannedSalePrice: 45000, thumbnailUrl: null, updatedAt: "2026-10-17T01:00:00.000Z" },
  { id: "preview-stool", sku: "見本003", name: "カウンタースツール / ブラック", quantity: 6, unit: "脚", location: "川越倉庫", category: "販売中", condition: "", note: "", barcode: "PREVIEW003", plannedSalePrice: 12800, thumbnailUrl: null, updatedAt: "2026-10-17T01:00:00.000Z" },
];

// Sample detail values are synthetic and never copied from an actual transaction.
for (const item of previewItems) {
  item.id = ['preview-chair','preview-table','preview-stool'].includes(item.id) ? '11111111-1111-4111-8111-00000000000'+(previewItems.indexOf(item)+1) : item.id;
  item.statusOptions = [
    { id: "preview-status-good", label: "目立った傷や汚れなし" },
    { id: "preview-status-worn", label: "やや傷や汚れあり" },
  ];
  item.statusId = item.statusOptions.find(option => option.label === item.condition)?.id ?? null;
  item.details = Object.fromEntries(DETAIL_FIELDS.map(field => [field.key, ""]));
  item.detailLoadedAt = item.updatedAt;
  item.photos = [];
}
Object.assign(previewItems[0].details!, {
  conditionRating: "3.5", damageNotes: "画面確認用：小傷あり", width: "46", depth: "54.5", height: "80",
  seatDimensions: "幅46 奥行40 高さ45", packageSize: "家財B", usedGoodsItemType: "椅子",
  usedGoodsFeature: "画面確認用のサンプル", purchaseQuantity: "3", transactionDate: "2026/08/28",
  transactionType: "買受", counterpartyName: "見本取引先", counterpartyOccupation: "販売業",
  counterpartyAddress: "画面確認用", purchasePrice: "5940", saleStartDate: "2026/09/15",
  listingNotes: "画面確認用の出品情報です。実際の出品は行いません。", adminMemo: "画面確認用のメモ",
});

/** Browser test fixtures; requested only by the explicit development-preview gallery URL. */
export function galleryPreviewItems(): InventoryItem[] {
  return previewItems.map((item, index) => index ? { ...item } : { ...item, photosComplete: true,
    photos: Array.from({ length: 33 }, (_, number) => ({ id: `gallery-${number}`, url: `https://bello-preview.invalid/thumb/${number}.png`, fullUrl: `https://bello-preview.invalid/full/${number}.png`, primary: number === 0, type: number < 30 ? "NORMAL" : "DAMAGE", source: number % 2 ? "PHOTO_ASSET" : "INVENTORY" })),
  });
}

/** Self-contained pictures for the tap-to-preview browser checks; no external inventory is read. */
export function photoPreviewImage(label:string,color:string) {
  return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200"><rect width="1200" height="1200" fill="#eeeae3"/><text x="80" y="110" font-size="42" fill="#263d3c">BELLO · ${label}</text><rect x="350" y="250" width="500" height="330" rx="26" fill="${color}"/><rect x="300" y="600" width="600" height="100" rx="20" fill="${color}"/><path d="M350 690v330M850 690v330" stroke="#665d50" stroke-width="35"/><text x="80" y="1130" font-size="32" fill="#555">操作確認用の画像</text></svg>`);
}
export function photoPreviewItems():InventoryItem[] {
  return Array.from({length:24},(_,index)=>({...previewItems[index%3],id:`11111111-1111-4111-8111-${String(index+1).padStart(12,'0')}`,sku:`写真確認${index+1}`,name:`写真確認 ${index+1} チェア`,thumbnailUrl:photoPreviewImage(`${index+1} / 主画像`,'#9b6b53'),photos:undefined,photosComplete:false}));
}
