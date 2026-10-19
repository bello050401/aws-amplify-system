import 'server-only';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {directTableName} from '@/lib/amplify/directData';
import {createInventoryPersistence} from './categoryPersistenceCore';
export type {InventoryTransaction} from './categoryPersistenceCore';
export const inventoryDdb = DynamoDBDocumentClient.from(new DynamoDBClient({region:process.env.AWS_REGION || 'us-west-2'}),{marshallOptions:{removeUndefinedValues:true}});
export const inventoryTable = directTableName;
export const {categoryLinkId,categoryLinkChanges,getInventoryRaw,validateCategoryIds,persistInventoryWithCategories,deleteInventoryWithCategories}=createInventoryPersistence(inventoryDdb,inventoryTable);
