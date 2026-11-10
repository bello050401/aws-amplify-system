import {ScanCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import type {InlineCustomDefinition} from './customFieldEdits';
/** Only the small field-definition master is scanned, never inventory. */
export async function readInventoryCustomDefinitions(db:DynamoDBDocumentClient,table:string):Promise<InlineCustomDefinition[]> {
  const definitions:InlineCustomDefinition[]=[];
  let cursor:Record<string,unknown>|undefined;
  do {
    const result=await db.send(new ScanCommand({TableName:table,ConsistentRead:true,ExclusiveStartKey:cursor,
      ProjectionExpression:'fieldKey,label,fieldType,#required,#options,isActive',ExpressionAttributeNames:{'#required':'required','#options':'options'}}));
    for(const row of result.Items??[])definitions.push({fieldKey:String(row.fieldKey),label:String(row.label),fieldType:String(row.fieldType),required:row.required===true,options:Array.isArray(row.options)?row.options.filter((v):v is string=>typeof v==='string'):[],isActive:row.isActive!==false});
    cursor=result.LastEvaluatedKey;
    if(definitions.length>1000)throw Error('追加項目の定義数が上限を超えています。');
  }while(cursor);
  return definitions;
}
