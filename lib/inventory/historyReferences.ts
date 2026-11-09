import type {TransactWriteCommandInput} from '@aws-sdk/lib-dynamodb';
import type {EditHistoryState} from './reversibleHistory';

/** Deployment-specific table matching prevents test/maintenance tables from
 * accidentally writing reference records into the production history store. */
export function historyReferenceTable(inventoryTable:string):string|undefined {
 const table=process.env.INVENTORY_EDIT_JOBS_TABLE;
 const expected=process.env.INVENTORY_HISTORY_TABLE;
 return table&&expected===inventoryTable?table:undefined;
}

export function historyReferenceChanges(table:string,id:string,before:EditHistoryState,after:EditHistoryState):NonNullable<TransactWriteCommandInput['TransactItems']>{
 const old=new Set(before.entries.map(e=>e.operationId)),next=new Set(after.entries.map(e=>e.operationId));
 return [
  ...[...old].filter(op=>!next.has(op)).map(op=>({Delete:{TableName:table,Key:{pk:'OP#'+op,sk:'REF#'+id}}})),
  ...[...next].filter(op=>!old.has(op)).map(op=>({Put:{TableName:table,Item:{pk:'OP#'+op,sk:'REF#'+id,inventoryId:id}}})),
 ];
}
