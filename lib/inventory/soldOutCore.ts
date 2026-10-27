import { createHash, randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createInventoryPersistence, type InventoryTransaction } from './categoryPersistenceCore';
import { inventoryCategoryIds } from './categories';
import { ALL_EXTENDED_FIELDS } from './extendedFields';
import { withHumanEdits, productCustomFields } from './humanEdits';
import { parseCustomFields, stringifyCustomFields } from './customFieldsCodec';
import { SoldOutError, validateSoldOut, type SoldOutRequest, type SoldOutResult } from './soldOutInput';
import {saleTitle} from './salePricing';
import {stockCountTitle} from './stockCountTitle';

type Row = Record<string, unknown>;
export interface SoldOutPorts {
  db: DynamoDBDocumentClient; table: (name:string)=>string;
  categories: ()=>Promise<{id:string;name:string}[]>;
  nextSku: ()=>Promise<string>;
  copyPhotos: (source:Row, attemptId:string)=>Promise<unknown[]>;
  discardPhotos: (images:unknown[])=>Promise<void>;
  now?: ()=>string;
  saleCommit?: (result:SoldOutResult,now:string)=>InventoryTransaction;
}
/** Both inventory records, category links and the retry receipt commit together. */
export function createSoldOutService(ports: SoldOutPorts) {
  const { db, table } = ports;
  const persistence = createInventoryPersistence(db, table);
  return async (request: SoldOutRequest, actor:string): Promise<SoldOutResult> => {
    // Full validation below allows an unchanged legacy market value.
    validateSoldOut(request, undefined, request?.market);
    const receiptId = `SOLD_OUT:${request.mutationId}`;
    const digest = createHash('sha256').update(JSON.stringify([actor, request.inventoryId, request.expectedUpdatedAt, request.quantity, request.name.trim(), request.saleEndDate, request.externalProductId.trim(), request.market, request.salePrice,...(request.saleCommission!==undefined||request.sourceCandidateId?[request.saleCommission??null,request.sourceCandidateId??null]:[]),...(request.pricing?[request.pricing]:[])])).digest('hex');
    const readReceipt = async () => {
      const receipt = (await db.send(new GetCommand({TableName:table('InventoryHistory'),Key:{id:receiptId},ConsistentRead:true}))).Item;
      if (!receipt) return null;
      const value = JSON.parse(receipt.newValue);
      if (value.requestHash !== digest) throw new SoldOutError('CONFLICT','この登録はすでに実行されています。商品を開き直してください。');
      return value.result as SoldOutResult;
    };
    const previous = await readReceipt(); if (previous) return previous;
    const source = await persistence.getInventoryRaw(request.inventoryId);
    if (!source || source.updatedAt !== request.expectedUpdatedAt) throw new SoldOutError('CONFLICT','ほかの操作で商品が変更されています。商品を開き直してください。');
    if (source.listingPartition === 'MERGED' || source.outboundBatchId || source.outboundArrivalBatchId) throw new SoldOutError('INVALID','出庫処理中または合算済みのため、処理が完了してから売却登録してください。');
    validateSoldOut(request, source.quantity, source.market ?? '');
    const masters = await ports.categories();
    const soldMaster = masters.filter(c=>c.name==='売り切れ'), activeMaster = masters.filter(c=>c.name==='販売中');
    if (soldMaster.length!==1 || activeMaster.length!==1) throw new SoldOutError('INVALID','カテゴリマスタの「販売中」「売り切れ」を確認してください。');
    const before = inventoryCategoryIds(source);
    if(request.sourceCandidateId&&!masters.some(c=>['販売中','出品中','出品待ち','撮影待ち','補修待ち'].includes(c.name)&&before.includes(c.id)))throw new SoldOutError('INVALID','この商品は売却候補の対象カテゴリから外れています。商品を選び直してください。');
    const sourceCustom = parseCustomFields(source.customFields);
    const saleCustom=request.pricing?{__belloSale:{...request.pricing,physicalQuantity:request.quantity,total:request.salePrice,commissionTotal:request.saleCommission,sourceInventoryId:source.id}}:{};
    if (before.includes(soldMaster[0].id)) throw new SoldOutError('INVALID','この商品はすでに売り切れです。');
    const activeIds=masters.filter(c=>['販売中','出品中'].includes(c.name)).map(c=>c.id);
    const after = [...before.filter(id=>!activeIds.includes(id)),soldMaster[0].id];
    await persistence.validateCategoryIds(after);
    const split = request.quantity < source.quantity;
    const now = new Date(Math.max(Date.parse(ports.now?.() ?? new Date().toISOString()),Date.parse(source.updatedAt)+1)).toISOString();
    const soldId = split ? randomUUID() : source.id;
    const changes: Row = {name:saleTitle(stockCountTitle(request.name,request.quantity),request.pricing),quantity:request.quantity,categoryId:after[0],categoryIds:after,saleEndDate:request.saleEndDate,externalProductId:request.externalProductId.trim(),market:request.market,salePrice:request.salePrice,updatedAt:now,listUpdatedAt:now,updatedBy:actor};
    if(request.saleCommission!==undefined)changes.saleCommission=request.saleCommission;
    const result: SoldOutResult = {sourceId:source.id,soldId,remainingQuantity:source.quantity-request.quantity,soldQuantity:request.quantity,updatedAt:now};
    let images: unknown[] = [];
    const writes: InventoryTransaction = [];
    // Version check also excludes a concurrent outbound reservation.
    const update = (values:Row) => {
      const entries=Object.entries(values).filter(([,v])=>v!==undefined);
      writes.push({Update:{TableName:table('Inventory'),Key:{id:source.id},
        UpdateExpression:'SET '+entries.map((_,i)=>`#f${i} = :v${i}`).join(', '),
        ConditionExpression:'updatedAt = :version AND quantity = :quantity AND attribute_not_exists(outboundBatchId) AND attribute_not_exists(outboundArrivalBatchId)',
        ExpressionAttributeNames:Object.fromEntries(entries.map(([key],i)=>[`#f${i}`,key])),
        ExpressionAttributeValues:{...Object.fromEntries(entries.map(([,value],i)=>[`:v${i}`,value])),':version':source.updatedAt,':quantity':source.quantity}}});
    };
    if (split) {
      const sku = await ports.nextSku();
      // New S3 objects: deleting either stock page must never break the other's photos.
      images = await ports.copyPhotos(source, soldId);
      const remainingName=stockCountTitle(source.name,result.remainingQuantity);
      const remaining = {...(remainingName!==source.name?{name:remainingName}:{}),quantity:result.remainingQuantity,updatedAt:now,listUpdatedAt:now,updatedBy:actor};
      update({...remaining,customFields:stringifyCustomFields(withHumanEdits(source,remaining,sourceCustom,sourceCustom ?? undefined))});
      const inherited: Row = {};
      for (const key of ['unit','statusId','locationId','note','barcode','purchasePrice',...ALL_EXTENDED_FIELDS.map(field=>field.key)]) if(source[key]!==undefined) inherited[key]=source[key];
      const custom = {...productCustomFields(sourceCustom),...saleCustom,__belloStockSplit:{sourceInventoryId:source.id,operation:'SOLD_OUT',mutationId:request.mutationId}};
      writes.push({Put:{TableName:table('Inventory'),Item:{...inherited,...changes,id:soldId,sku,images,customFields:stringifyCustomFields(custom),sourceSystem:'BELLO',listingPartition:'ACTIVE',createdAt:now,createdBy:actor,__typename:'Inventory'},ConditionExpression:'attribute_not_exists(id)'}});
      writes.push(...persistence.categoryLinkChanges(soldId,[],after,now));
    } else {
      update({...changes,customFields:stringifyCustomFields({...withHumanEdits(source,changes,sourceCustom,sourceCustom ?? undefined),...saleCustom})});
      writes.push(...persistence.categoryLinkChanges(source.id,before,after,now));
    }
    const oldValue=JSON.stringify({quantity:source.quantity,name:source.name,categoryIds:before,saleEndDate:source.saleEndDate,externalProductId:source.externalProductId,market:source.market,salePrice:source.salePrice});
    const history = {inventoryId:source.id,fieldName:'売却登録',oldValue,newValue:JSON.stringify({requestHash:digest,result,changes,...(split?{remainingName:stockCountTitle(source.name,result.remainingQuantity)}:{})}),changedBy:actor,changedAt:now,createdAt:now,updatedAt:now,__typename:'InventoryHistory'};
    writes.push({Put:{TableName:table('InventoryHistory'),Item:{...history,id:receiptId},ConditionExpression:'attribute_not_exists(id)'}});
    if(split) writes.push({Put:{TableName:table('InventoryHistory'),Item:{...history,id:`${receiptId}:SPLIT`,inventoryId:soldId,fieldName:'売却分を分割'}}});
    if(ports.saleCommit)writes.push(...ports.saleCommit(result,now));
    try { await db.send(new TransactWriteCommand({TransactItems:writes,ClientRequestToken:randomUUID()})); }
    catch(error) {
      // A lost response is not evidence of rollback. Check the durable receipt first.
      const committed = await readReceipt().catch(()=>null);
      if (committed) {
        if(split && committed.soldId!==soldId) await ports.discardPhotos(images);
        return committed;
      }
      if (error instanceof Error && error.name==='TransactionCanceledException') {
        if(split) await ports.discardPhotos(images);
        throw new SoldOutError('CONFLICT','同時に別の更新が行われたため登録していません。商品を開き直してください。');
      }
      // Keep uncertain photo copies until the existing orphan sweep can prove no references.
      throw new SoldOutError('UNCONFIRMED','登録結果を確認できません。同じ内容で「登録結果を再確認」を押してください。');
    }
    return result;
  };
}
