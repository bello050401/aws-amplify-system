import 'server-only';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,GetCommand,ScanCommand,type ScanCommandInput} from '@aws-sdk/lib-dynamodb';
import {EconveniWorkflowStore,type EconveniWorkflow} from './workflowStore';
export const ECONVENI_WORKFLOW_TABLE='BelloEconveniWorkflow';
export const econveniDatabase=DynamoDBDocumentClient.from(new DynamoDBClient({region:process.env.AWS_REGION||'us-west-2',maxAttempts:2}),{marshallOptions:{removeUndefinedValues:true}});
export const econveniStore=(id:string)=>new EconveniWorkflowStore(id,econveniDatabase,ECONVENI_WORKFLOW_TABLE);
export async function readEconveniCatalog(inventoryId?:string){
  if(inventoryId){
    const result=await econveniDatabase.send(new GetCommand({TableName:ECONVENI_WORKFLOW_TABLE,Key:{pk:'ECONVENI#INVENTORY#'+inventoryId},ConsistentRead:true}));
    return result.Item?[result.Item as EconveniWorkflow]:[];
  }
  const rows:EconveniWorkflow[]=[];let key:ScanCommandInput['ExclusiveStartKey'];
  do{
    const r=await econveniDatabase.send(new ScanCommand({TableName:ECONVENI_WORKFLOW_TABLE,ExclusiveStartKey:key,
      FilterExpression:'begins_with(pk,:prefix)',ExpressionAttributeValues:{':prefix':'ECONVENI#INVENTORY#'},
      ProjectionExpression:'pk,inventoryId,revision,updatedAt,#save.#state,#save.productId,channels',ExpressionAttributeNames:{'#save':'save','#state':'state'}}));
    rows.push(...(r.Items??[]) as EconveniWorkflow[]);key=r.LastEvaluatedKey;
    if(rows.length>20000)throw Error('CATALOG_LIMIT');
  }while(key);
  return rows;
}
