import {sendInventoryHistoryCommand} from "@/lib/inventory/historyTransaction";
import { createHash, randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createInventoryPersistence, type InventoryTransaction } from './categoryPersistenceCore';
import { inventoryCategoryIds } from './categories';
import { ALL_EXTENDED_FIELDS } from './extendedFields';
import { withHumanEdits, productCustomFields } from './humanEdits';
import { parseCustomFields, stringifyCustomFields } from './customFieldsCodecCore';
import { SoldOutError, validateSoldOut, type SoldOutRequest, type SoldOutResult } from './soldOutInput';
import {saleTitle} from './salePricing';
import {stockCountTitle} from './stockCountTitle';
import {managedStockTitleChange,hasManagedStockTitle,managedTitleBase} from './managedStockTitle';
import {paymentDate,type YahooPaymentPlan,type YahooStockReservation} from '../saleCandidates/yahooPaymentModel';

type Row = Record<string, unknown>;
export interface SoldOutPorts {
  db: DynamoDBDocumentClient; table: (name:string)=>string;
  categories: ()=>Promise<{id:string;name:string}[]>;
  nextSku: ()=>Promise<string>;
  copyPhotos: (source:Row, attemptId:string)=>Promise<unknown[]>;
  discardPhotos: (images:unknown[])=>Promise<void>;
  now?: ()=>string;
  saleCommit?: (result:SoldOutResult,now:string)=>InventoryTransaction;
  yahooPayment?:YahooPaymentPlan;
  /** Worker-only: an authenticated payment settles the durable reservation. */
  settlingYahooPayment?: boolean;
}
/** Both inventory records, category links and the retry receipt commit together. */
export function createSoldOutService(ports: SoldOutPorts) {
  const { db, table } = ports;
  const persistence = createInventoryPersistence(db, table);
  return async (request: SoldOutRequest, actor:string): Promise<SoldOutResult> => {
    const payment=ports.yahooPayment;
    if(!request)throw new SoldOutError('INVALID','商品を開き直してから登録してください。');
    if(request.awaitingYahooPayment&&!payment)throw new SoldOutError('INVALID','ヤフオクの購入通知から売却登録してください。');
    if(payment){
      if(request.market!=='ヤフオク'||request.sourceCandidateId!==payment.candidateId||typeof request.externalProductId!=='string'||request.externalProductId.trim()!==payment.auctionId)throw new SoldOutError('INVALID','通知のオークションIDと売却対象を確認してください。');
      request={...request,awaitingYahooPayment:payment.waiting,saleEndDate:payment.waiting?'':paymentDate(payment.paidAt!)};
    }
    // Full validation below allows an unchanged legacy market value.
    validateSoldOut(request, undefined, request?.market);
    const receiptId = `${payment?.waiting?'YAHOO_RESERVATION':'SOLD_OUT'}:${request.mutationId}`;
    const digest = createHash('sha256').update(JSON.stringify([actor, request.inventoryId, request.expectedUpdatedAt, request.quantity, request.name.trim(), request.saleEndDate, request.externalProductId.trim(), request.market, request.salePrice,...(request.saleCommission!==undefined||request.sourceCandidateId?[request.saleCommission??null,request.sourceCandidateId??null]:[]),...(request.pricing?[request.pricing]:[]),...(request.saleShippingReceived!==undefined?[{shippingReceived:request.saleShippingReceived}]:[])])).digest('hex');
    const readReceipt = async () => {
      const receipt = (await db.send(new GetCommand({TableName:table('InventoryHistory'),Key:{id:receiptId},ConsistentRead:true}))).Item;
      if (!receipt) return null;
      const value = JSON.parse(receipt.newValue);
      if (value.requestHash !== digest) throw new SoldOutError('CONFLICT','この登録はすでに実行されています。商品を開き直してください。');
      return value.result as SoldOutResult;
    };
    const previous = await readReceipt(); if (previous) return previous;
    const source = await persistence.getInventoryRaw(request.inventoryId);
    if (!source || source.deletedAt || source.isDeleted || source.updatedAt !== request.expectedUpdatedAt) throw new SoldOutError('CONFLICT','ほかの操作で商品が変更されています。商品を開き直してください。');
    if (source.listingPartition === 'MERGED' || source.outboundBatchId || source.outboundArrivalBatchId) throw new SoldOutError('INVALID','出庫処理中または合算済みのため、処理が完了してから売却登録してください。');
    validateSoldOut(request, source.quantity, source.market ?? '');
    const masters = await ports.categories();
    const soldMaster = masters.filter(c=>c.name==='売り切れ'), activeMaster = masters.filter(c=>c.name==='販売中');
    if (soldMaster.length!==1 || activeMaster.length!==1) throw new SoldOutError('INVALID','カテゴリマスタの「販売中」「売り切れ」を確認してください。');
    const currentCategories = inventoryCategoryIds(source);
    const sourceCustom = parseCustomFields(source.customFields);
    const reservation = sourceCustom?.__belloYahooPayment as YahooStockReservation | undefined;
    const settling = ports.settlingYahooPayment && payment && !payment.waiting;
    if (reservation?.state==='WAITING' && !settling) throw new SoldOutError('CONFLICT','この商品はヤフオクの入金待ちです。入金確認後に数量を更新します。');
    if (settling && (!reservation?.quantityDeferred || reservation.candidateId!==payment.candidateId || reservation.auctionId!==payment.auctionId || reservation.sourceQuantity!==source.quantity || reservation.sourceMarket!==(source.market??'') || reservation.sourceExternalProductId!==(source.externalProductId??'') || reservation.request?.mutationId!==request.mutationId || reservation.request?.quantity!==request.quantity || !Array.isArray(reservation.beforeCategoryIds) || !Array.isArray(reservation.waitingCategoryIds) || JSON.stringify(currentCategories)!==JSON.stringify(reservation.waitingCategoryIds) || source.saleEndDate)) throw new SoldOutError('CONFLICT','入金待ちの商品情報が変更されています。数量とカテゴリを確認してください。');
    const before: string[] = settling ? reservation!.beforeCategoryIds : currentCategories;
    const unpaidMasters=masters.filter(c=>c.name==='未入金'||c.name==='入金待ち');
    const unpaid=unpaidMasters.find(c=>c.name==='未入金')||unpaidMasters.find(c=>c.name==='入金待ち');
    if(payment?.waiting&&!unpaid)throw new SoldOutError('INVALID','未入金のカテゴリを確認してください。');
    if(request.sourceCandidateId&&!masters.some(c=>['販売中','出品中','出品待ち','撮影待ち','補修待ち'].includes(c.name)&&before.includes(c.id)))throw new SoldOutError('INVALID','この商品は売却候補の対象カテゴリから外れています。商品を選び直してください。');
    const saleCustom={...(request.pricing||request.saleShippingReceived!==undefined||payment?{__belloSale:{...request.pricing,physicalQuantity:request.quantity,total:request.salePrice,commissionTotal:request.saleCommission,sourceInventoryId:source.id,...(request.saleShippingReceived!==undefined?{shippingReceived:request.saleShippingReceived}:{})}}:{}),...(payment?{__belloYahooPayment:{candidateId:payment.candidateId,auctionId:payment.auctionId,state:payment.waiting?'WAITING':'APPLIED',...(payment.waiting?{unpaidCategoryId:unpaid!.id}:{paidAt:payment.paidAt})}}:{})};
    if (before.includes(soldMaster[0].id)) throw new SoldOutError('INVALID','この商品はすでに売り切れです。');
    const activeIds=masters.filter(c=>['販売中','出品中'].includes(c.name)).map(c=>c.id);
    const after = [...before.filter(id=>!activeIds.includes(id)&&(!payment||!unpaidMasters.some(c=>c.id===id))),soldMaster[0].id,...(payment?.waiting?[unpaid!.id]:[])];
    await persistence.validateCategoryIds(after);
    const split = request.quantity < source.quantity;
    const now = new Date(Math.max(Date.parse(ports.now?.() ?? new Date().toISOString()),Date.parse(source.updatedAt)+1)).toISOString();
    if (payment?.waiting) {
      // Keep physical quantity, title, prices and photos unchanged until payment.
      // A partial reservation keeps the remaining stock's original categories.
      const waitingCategories = split ? [...new Set([...before,unpaid!.id])] : after;
      const result:SoldOutResult={sourceId:source.id,soldId:source.id,soldQuantity:request.quantity,remainingQuantity:source.quantity-request.quantity,sourceQuantity:source.quantity,quantityDeferred:true,updatedAt:now};
      const marker={candidateId:payment.candidateId,auctionId:payment.auctionId,state:'WAITING',quantityDeferred:true,sourceQuantity:source.quantity,sourceMarket:source.market??'',sourceExternalProductId:source.externalProductId??'',beforeCategoryIds:before,waitingCategoryIds:waitingCategories,unpaidCategoryId:unpaid!.id,request};
      const changes={categoryId:waitingCategories[0],categoryIds:waitingCategories,saleEndDate:null,updatedAt:now,listUpdatedAt:now,updatedBy:actor};
      const values={...changes,customFields:stringifyCustomFields({...withHumanEdits(source,changes,sourceCustom,sourceCustom??undefined),__belloYahooPayment:marker})};
      const entries=Object.entries(values);
      const writes:InventoryTransaction=[{Update:{TableName:table('Inventory'),Key:{id:source.id},UpdateExpression:'SET '+entries.map((_,i)=>`#f${i}=:v${i}`).join(','),ConditionExpression:'updatedAt=:version AND quantity=:quantity AND attribute_not_exists(outboundBatchId) AND attribute_not_exists(outboundArrivalBatchId)',ExpressionAttributeNames:Object.fromEntries(entries.map(([k],i)=>['#f'+i,k])),ExpressionAttributeValues:{...Object.fromEntries(entries.map(([,v],i)=>[':v'+i,v])),':version':source.updatedAt,':quantity':source.quantity}}},...persistence.categoryLinkChanges(source.id,currentCategories,waitingCategories,now),{Put:{TableName:table('InventoryHistory'),Item:{id:receiptId,inventoryId:source.id,fieldName:'ヤフオク入金待ち登録',oldValue:JSON.stringify({quantity:source.quantity,categoryIds:before}),newValue:JSON.stringify({requestHash:digest,result}),changedBy:actor,changedAt:now,createdAt:now,updatedAt:now,__typename:'InventoryHistory'},ConditionExpression:'attribute_not_exists(id)'}},...(ports.saleCommit?.(result,now)??[])];
      try {await sendInventoryHistoryCommand(db, new TransactWriteCommand({TransactItems:writes}));}
      catch(error){const committed=await readReceipt().catch(()=>null);if(committed)return committed;if((error as Error).name==='TransactionCanceledException')throw new SoldOutError('CONFLICT','同時に商品または入金情報が変更されました。通知を開き直してください。');throw new SoldOutError('UNCONFIRMED','登録結果を確認できません。同じ内容で結果を再確認してください。');}
      return result;
    }
    const soldId = split ? randomUUID() : source.id;
    const changes: Row = {name:saleTitle(hasManagedStockTitle(source)?managedTitleBase(request.name,source):stockCountTitle(request.name,request.quantity),request.pricing),quantity:request.quantity,categoryId:after[0],categoryIds:after,saleEndDate:payment?.waiting?null:request.saleEndDate,externalProductId:request.externalProductId.trim(),market:request.market,salePrice:request.salePrice,updatedAt:now,listUpdatedAt:now,updatedBy:actor};
    if(request.saleCommission!==undefined)changes.saleCommission=request.saleCommission;
    const result: SoldOutResult = {sourceId:source.id,soldId,remainingQuantity:source.quantity-request.quantity,soldQuantity:request.quantity,updatedAt:now};
    let images: unknown[] = [];
    const writes: InventoryTransaction = [];
    // Version check also excludes a concurrent outbound reservation.
    const update = (values:Row) => {
      const entries=Object.entries(managedStockTitleChange(values,source)).filter(([,v])=>v!==undefined);
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
      const remainingName=hasManagedStockTitle(source)?source.name:stockCountTitle(source.name,result.remainingQuantity);
      const remaining = {...(remainingName!==source.name?{name:remainingName}:{}),quantity:result.remainingQuantity,updatedAt:now,listUpdatedAt:now,updatedBy:actor};
      const remainingChanges={...remaining,...(settling?{categoryId:before[0],categoryIds:before}:{})};
      const remainingCustom=withHumanEdits(source,remainingChanges,sourceCustom,sourceCustom ?? undefined);
      if(settling)delete remainingCustom.__belloYahooPayment;
      update({...remainingChanges,customFields:stringifyCustomFields(remainingCustom)});
      if(settling)writes.push(...persistence.categoryLinkChanges(source.id,currentCategories,before,now));
      const inherited: Row = {};
      for (const key of ['unit','statusId','locationId','note','barcode','purchasePrice',...ALL_EXTENDED_FIELDS.map(field=>field.key)]) if(source[key]!==undefined) inherited[key]=source[key];
      const custom = {...productCustomFields(sourceCustom),...saleCustom,__belloStockSplit:{sourceInventoryId:source.id,operation:'SOLD_OUT',mutationId:request.mutationId}};
      writes.push({Put:{TableName:table('Inventory'),Item:managedStockTitleChange({...inherited,...changes,id:soldId,sku,images,customFields:stringifyCustomFields(custom),sourceSystem:'BELLO',listingPartition:'ACTIVE',createdAt:now,createdBy:actor,__typename:'Inventory'},source),ConditionExpression:'attribute_not_exists(id)'}});
      writes.push(...persistence.categoryLinkChanges(soldId,[],after,now));
    } else {
      update({...changes,customFields:stringifyCustomFields({...withHumanEdits(source,changes,sourceCustom,sourceCustom ?? undefined),...saleCustom})});
      writes.push(...persistence.categoryLinkChanges(source.id,currentCategories,after,now));
    }
    const oldValue=JSON.stringify({quantity:source.quantity,name:source.name,categoryIds:before,saleEndDate:source.saleEndDate,externalProductId:source.externalProductId,market:source.market,salePrice:source.salePrice});
    const history = {inventoryId:source.id,fieldName:'売却登録',oldValue,newValue:JSON.stringify({requestHash:digest,result,changes:{...changes,name:managedStockTitleChange(changes,source).name},...(request.saleShippingReceived!==undefined?{shippingReceived:request.saleShippingReceived}:{}),...(split?{remainingName:hasManagedStockTitle(source)?managedStockTitleChange({quantity:result.remainingQuantity},source).name:stockCountTitle(source.name,result.remainingQuantity)}:{})}),changedBy:actor,changedAt:now,createdAt:now,updatedAt:now,__typename:'InventoryHistory'};
    writes.push({Put:{TableName:table('InventoryHistory'),Item:{...history,id:receiptId},ConditionExpression:'attribute_not_exists(id)'}});
    if(split) writes.push({Put:{TableName:table('InventoryHistory'),Item:{...history,id:`${receiptId}:SPLIT`,inventoryId:soldId,fieldName:'売却分を分割'}}});
    if(ports.saleCommit)writes.push(...ports.saleCommit(result,now));
    try { await sendInventoryHistoryCommand(db, new TransactWriteCommand({TransactItems:writes,ClientRequestToken:randomUUID()})); }
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
