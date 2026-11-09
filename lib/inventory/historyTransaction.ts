import { randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand, type TransactWriteCommandInput, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { inventoryCategoryIds } from './categories';
import { recordInventorySave, readEditHistory, sameValue, type EditHistoryState } from './reversibleHistory';
import {historyReferenceTable,historyReferenceChanges} from './historyReferences';

type Row = Record<string, unknown>;
type Writes = NonNullable<TransactWriteCommandInput['TransactItems']>;
type Update = NonNullable<Writes[number]['Update']>;
export interface HistoryWriteContext {
  source: string; actor?: string; operationId?: string;
  blockedReason?:string;
  /** Consistently read snapshots. Each write still checks their version in DynamoDB. */
  before?: Map<string, Row>;
  /** Only the dedicated history operation may provide an already validated cursor move. */
  restore?: Map<string, { state:EditHistoryState; revision:number }>;
}

/** Inventory writers use top-level SET values / REMOVE attributes. Fail closed
 * instead of silently missing a history when a writer adds an unsupported expression. */
export function applyInventoryUpdateExpression(row:Row, update:Update):Row {
  const after=structuredClone(row), names=update.ExpressionAttributeNames??{}, values=update.ExpressionAttributeValues??{};
  const expression=update.UpdateExpression??'';
  const clauses=[...expression.matchAll(/\b(SET|REMOVE|ADD|DELETE)\b\s+([\s\S]*?)(?=\b(?:SET|REMOVE|ADD|DELETE)\b|$)/g)];
  if(!clauses.length)throw new Error('INVENTORY_HISTORY_UNSUPPORTED_EXPRESSION');
  const field=(raw:string)=>{const key=names[raw]??raw;if(!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(key))throw new Error('INVENTORY_HISTORY_UNSUPPORTED_PATH');return key;};
  for(const [,kind,body] of clauses){
    if(kind==='REMOVE')for(const token of body.split(','))delete after[field(token.trim())];
    else if(kind==='SET')for(const assignment of body.split(',')){
      const match=assignment.trim().match(/^(#[\w]+|[\w]+)\s*=\s*(:[\w]+)$/);
      if(!match||!Object.hasOwn(values,match[2]))throw new Error('INVENTORY_HISTORY_UNSUPPORTED_ASSIGNMENT');
      after[field(match[1])]=structuredClone(values[match[2]]);
    }
    else throw new Error('INVENTORY_HISTORY_UNSUPPORTED_ARITHMETIC');
  }
  return after;
}
function setAttributes(update:Update, attributes:Row) {
  update.ExpressionAttributeNames={...update.ExpressionAttributeNames};
  update.ExpressionAttributeValues={...update.ExpressionAttributeValues};
  const sets=Object.entries(attributes).map(([field,value],i)=>{
    const name='#history'+i,token=':history'+i;
    if(update.ExpressionAttributeNames![name]||Object.hasOwn(update.ExpressionAttributeValues!,token))throw new Error('INVENTORY_HISTORY_TOKEN_COLLISION');
    update.ExpressionAttributeNames![name]=field;update.ExpressionAttributeValues![token]=value;
    return name+'='+token;
  });
  // Existing setters for internal history attributes are prohibited at callers.
  update.UpdateExpression=/^SET\s/.test(update.UpdateExpression??'')
    ? update.UpdateExpression!.replace(/^SET\s+/, 'SET '+sets.join(', ')+', ')
    : 'SET '+sets.join(', ')+' '+update.UpdateExpression;
}
export async function prepareInventoryHistoryWrites(db:Pick<DynamoDBDocumentClient,'send'>,writes:Writes,context:HistoryWriteContext) {
  const next=structuredClone(writes),operationId=context.operationId??randomUUID(),rows=new Map<string,Row>();
  const updates=next.flatMap(w=>w.Update&&/^Inventory(?:-|$)/.test(w.Update.TableName??'')?[w.Update]:[]);
  const createsInventory=next.some(w=>w.Put&&/^Inventory(?:-|$)/.test(w.Put.TableName??''));
  const changesBusinessOperation=next.some(w=>{
    const change=w.Put??w.Update??w.Delete,table=change?.TableName??'';
    const audit=w.Put?.Item?.fieldName;
    return /^(SaleCandidate|OutboundItem|OutboundBatch|SaleStockReservation)(?:-|$)/.test(table)||
      typeof audit==='string'&&/売却|入金確認|入金待ち登録|数量合算/.test(audit);
  });
  // One bounded read wave. The caller can supply batch-read versions to remove N+1 reads.
  for(let offset=0;offset<updates.length;offset+=8)await Promise.all(updates.slice(offset,offset+8).map(async update=>{
    const id=String(update.Key?.id);
    const current=context.before?.get(id)??(await db.send(new GetCommand({TableName:update.TableName,Key:update.Key,ConsistentRead:true}))).Item;
    if(!current)throw new Error('INVENTORY_HISTORY_TARGET_MISSING');
    const before={...current,categoryIds:inventoryCategoryIds(current)};
    const after=applyInventoryUpdateExpression(before,update);
    if(!sameValue(current.editHistory,after.editHistory)||current.revision!==after.revision)throw new Error('INVENTORY_HISTORY_DIRECT_STATE_WRITE');
    const restore=context.restore?.get(id);
    const blockedReason=context.blockedReason??(createsInventory?'在庫分けで別の商品が作成されています。数量が重複するため、この保存は通常の「戻る」では取り消せません。':changesBusinessOperation?'売却・出庫の処理記録と関連する保存です。在庫だけ戻すと取引記録と一致しなくなるため、元の業務画面で訂正してください。':undefined);
    const recorded=restore?{changed:true,state:restore.state,row:{...after,editHistory:restore.state,revision:restore.revision}}
      :recordInventorySave(before,after,{id:randomUUID(),operationId,actor:context.actor??String(after.updatedBy??'システム'),source:context.source,at:String(after.updatedAt??new Date().toISOString()),...(blockedReason?{blockedReason}:{})});
    if(!recorded.changed)return;
    const refs=historyReferenceTable(update.TableName!);
    if(refs)next.push(...historyReferenceChanges(refs,id,readEditHistory(before),recorded.state));
    const stateRow=recorded.row;
    if(Buffer.byteLength(JSON.stringify(stateRow),'utf8')>350_000)throw new Error('履歴を含む商品情報が保存上限に近づいています。長文・添付情報を確認してください。');
    setAttributes(update,{editHistory:recorded.state,revision:stateRow.revision});
    update.ExpressionAttributeNames!['#historyVersion']='updatedAt';
    update.ExpressionAttributeValues![':historyVersion']=current.updatedAt;
    update.ConditionExpression=(update.ConditionExpression?'('+update.ConditionExpression+') AND ':'')+'#historyVersion=:historyVersion';
    // A later save/undo is rejected even if business values happen to be equal.
    update.ExpressionAttributeNames!['#historyRevision']='revision';
    if(current.revision===undefined)update.ConditionExpression+=' AND attribute_not_exists(#historyRevision)';
    else{update.ExpressionAttributeValues![':historyRevision']=current.revision;update.ConditionExpression+=' AND #historyRevision=:historyRevision';}
    rows.set(id,stateRow);
  }));
  if(next.length>100)throw new Error('履歴を含む更新が一度に保存できる件数を超えています。対象を分けてください。');
  return {writes:next,rows,operationId};
}
/** Preserve the caller's original atomic transaction, adding only the two-delta
 * state to its existing inventory update. No inventory/table snapshot is copied. */
export async function sendInventoryTransaction(db:Pick<DynamoDBDocumentClient,'send'>,input:TransactWriteCommandInput,context:HistoryWriteContext){
  const prepared=await prepareInventoryHistoryWrites(db,input.TransactItems??[],context);
  const command=new TransactWriteCommand({...input,ClientRequestToken:input.ClientRequestToken??randomUUID(),TransactItems:prepared.writes});
  for(let attempt=0;;attempt++){
    try{const result=await db.send(command);return {...result,inventoryUpdates:prepared.rows};}
    catch(error){
      const reasons=(error as {CancellationReasons?:{Code?:string}[]}).CancellationReasons;
      const retryableCodes=['None','TransactionConflict','ThrottlingError','ProvisionedThroughputExceeded'];
      const retryable=['TransactionConflictException','TransactionInProgressException','ThrottlingException','ProvisionedThroughputExceededException','RequestLimitExceeded','InternalServerError','TimeoutError'].includes((error as Error).name)||
        ((error as Error).name==='TransactionCanceledException'&&reasons?.some(r=>r.Code&&r.Code!=='None')&&reasons.every(r=>!r.Code||retryableCodes.includes(r.Code)));
      if(!retryable||attempt>=7)throw error;
      // Retry exactly the same prepared delta and token. A changed revision is
      // never retried, even if another row also reports a transaction collision.
      await new Promise(resolve=>setTimeout(resolve,Math.min(1200,40*2**attempt)*(0.5+Math.random())));
    }
  }
}

export async function sendInventoryHistoryCommand(db:Pick<DynamoDBDocumentClient,'send'>,command:TransactWriteCommand,source='在庫更新'){
 return sendInventoryTransaction(db,command.input,{source});
}
