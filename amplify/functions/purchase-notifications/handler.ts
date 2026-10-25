import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {importPurchases} from '../../../lib/saleCandidates/importer';
const db=DynamoDBDocumentClient.from(new DynamoDBClient({}),{marshallOptions:{removeUndefinedValues:true}});
export async function handler(){return importPurchases(db,process.env.SALE_CANDIDATES_TABLE!);}
