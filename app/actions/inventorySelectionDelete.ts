'use server';
import {SQSClient,SendMessageCommand} from '@aws-sdk/client-sqs';
import {inventoryMutationSession} from '@/lib/inventory/mutationSession';
import {inventoryDdb,inventoryTable} from '@/lib/inventory/categoryPersistence';
import {inventoryEditConfig} from '@/lib/inventory/editJobs';
import {createSelectionDeleteJobs,type DeleteTarget} from '@/lib/inventory/selectionDeleteJobs';
import {canHardDeleteInventory} from '@/lib/amplify/requireInventoryUser';
import {clearInventoryCountCache} from '@/lib/inventory/inventoryPage';
import {revalidatePath} from 'next/cache';
function runtime(){const config=inventoryEditConfig();return createSelectionDeleteJobs({db:inventoryDdb,table:inventoryTable,jobsTable:config.table,authorize:async()=>false,enqueue:async id=>{await new SQSClient({region:config.region}).send(new SendMessageCommand({QueueUrl:config.queueUrl,MessageBody:JSON.stringify({kind:'selection-delete',id})}));}});}
export async function startInventorySelectionDelete(id:string,targets:DeleteTarget[],confirmed:boolean){const s=await inventoryMutationSession();if(!s||!canHardDeleteInventory(s.role as "ADMIN"|"EDITOR"|"VIEWER"))throw Error('在庫を削除する権限がありません。');if(confirmed!==true)throw Error('削除の確認が必要です。');return runtime().create(id,targets,s.owner);}
export async function inventorySelectionDeleteStatus(id:string){const s=await inventoryMutationSession();if(!s)throw Error('ログインが必要です。');const result=await runtime().status(id,s.owner);if(result.items.some(i=>i.state==='SAVED')){clearInventoryCountCache();revalidatePath('/inventory');}return result;}
export async function resumeInventorySelectionDelete(id:string){const s=await inventoryMutationSession();if(!s||!canHardDeleteInventory(s.role as "ADMIN"|"EDITOR"|"VIEWER"))throw Error('在庫を削除する権限がありません。');return runtime().resume(id,s.owner);}
