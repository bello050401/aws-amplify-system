import assert from 'node:assert/strict';
import {mobileInventoryDetail} from '../lib/mobile/inventoryDetail';
import {mobileInventoryInput} from '../lib/mobile/inventoryWrite';
import {draftFor} from '../mobile/src/domain/inventory';
import {DETAIL_FIELDS} from '../mobile/src/domain/detailFields';
import type {InventoryDetail} from '../lib/inventory/queries';
const row={id:'11111111-1111-4111-8111-111111111111',sku:'QA',name:'元の商品名',quantity:5,
 unit:'点',categoryIds:[],categoryId:null,locationId:null,statusId:null,note:'',barcode:'123',plannedSalePrice:null,
 updatedAt:'2026-10-29T00:00:00Z',images:[],customFields:{outboundName:'送信した名前',unrelated:'維持'}} as unknown as InventoryDetail;
const features={ecListing:true,sales:true};
const projected=mobileInventoryDetail(row,[],[],[],features,[],row.updatedAt);
assert.equal(projected.details?.outboundName,'送信した名前');
assert.equal(DETAIL_FIELDS.at(-1)?.key,'outboundName');
const request={id:row.id,mutationId:'22222222-2222-4222-8222-222222222222',expectedUpdatedAt:row.updatedAt,draft:draftFor(projected)};
request.draft.note='通常編集';
const input=mobileInventoryInput(row,request,'qa',features,[],[],[]);
assert.equal(input.customFields?.outboundName,'送信した名前');
assert.equal(input.customFields?.unrelated,'維持');
assert.equal(input.name,'元の商品名');
console.log('PASS: mobile last field projection and normal editing preserve the dispatched name and master title');
