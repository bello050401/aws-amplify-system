import 'server-only';
import {randomUUID} from 'node:crypto';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,GetCommand,UpdateCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {yahooRuntimeConfig} from './webHttpRuntime';
import type {YahooAuctionSaved} from './preparation';
import type {YahooUploadedImage} from './webHttpSession';
import type {YahooListingResult} from './listingResult';
import type {YahooWorkflowView} from './workflowTypes';

export type WorkflowState={pk:string;revision:number;stage:YahooWorkflowView['stage'];jobId:string;
  saved?:YahooAuctionSaved;fingerprint?:string;images:YahooUploadedImage[];imageSourceHash?:string;
  listing:YahooListingResult|null;candidateId?:string;relistId?:string;error?:string;readyAt?:number;
  lastOperation?:'PUBLISH'|'CANCEL'|'IMAGE';updatedAt:string};
export class WorkflowFailure extends Error {
  constructor(public code:string,public waitUntil?:number){super(code);}
}
export const SEND_INTERVAL_MS=30_000;
export const LEASE_MS=180_000;
export const uncertainStage=(s:WorkflowState['stage'])=>['IMAGE_PENDING','PUBLISH_PENDING','CANCEL_PENDING','VERIFY_REQUIRED'].includes(s);

/** No client access to this table. Account lease + inventory revision and send
 * timestamp change in one transaction. A lost acknowledgement never permits a
 * second send. Expired leases permit reconciliation, not retrying pending POSTs. */
export class YahooWorkflowStore {
  readonly owner=randomUUID();
  readonly pk:string;
  private ddb;
  private table:string;
  constructor(inventoryId:string, transport?:DynamoDBDocumentClient, table?:string){
    const c=yahooRuntimeConfig();
    if(!table&&!c?.stateTable)throw new WorkflowFailure('NOT_CONFIGURED');
    this.table=table??c!.stateTable!;this.pk='INVENTORY#'+inventoryId;
    this.ddb=transport??DynamoDBDocumentClient.from(new DynamoDBClient({region:c!.region,maxAttempts:1}),{marshallOptions:{removeUndefinedValues:true}});
  }
  async read():Promise<WorkflowState|null>{
    const r=await this.ddb.send(new GetCommand({TableName:this.table,Key:{pk:this.pk},ConsistentRead:true}));
    return r.Item as WorkflowState??null;
  }
  async account():Promise<{leaseUntil?:number;lastSentAt?:number;owner?:string}>{
    const r=await this.ddb.send(new GetCommand({TableName:this.table,Key:{pk:'ACCOUNT'},ConsistentRead:true}));
    return r.Item??{};
  }
  async acquire(){
    const now=Date.now();
    try {await this.ddb.send(new UpdateCommand({TableName:this.table,Key:{pk:'ACCOUNT'},
      UpdateExpression:'SET #owner=:owner, leaseUntil=:until',ConditionExpression:'attribute_not_exists(leaseUntil) OR leaseUntil < :now',
      ExpressionAttributeNames:{'#owner':'owner'},ExpressionAttributeValues:{':owner':this.owner,':until':now+LEASE_MS,':now':now}}));}
    catch{throw new WorkflowFailure('BUSY');}
  }
  async release(){
    try{await this.ddb.send(new UpdateCommand({TableName:this.table,Key:{pk:'ACCOUNT'},UpdateExpression:'REMOVE #owner, leaseUntil',
      ConditionExpression:'#owner=:owner',ExpressionAttributeNames:{'#owner':'owner'},ExpressionAttributeValues:{':owner':this.owner}}));}catch{/* lease expiry recovers; no write or external request follows */}
  }
  async commit(previous:WorkflowState|null,next:WorkflowState,reserveSend=false):Promise<WorkflowState>{
    const now=Date.now(), value={...next,pk:this.pk,revision:(previous?.revision??0)+1,updatedAt:new Date(now).toISOString()};
    if(reserveSend){const account=await this.account();const waitUntil=(account.lastSentAt??0)+SEND_INTERVAL_MS;
      if(waitUntil>now)throw new WorkflowFailure('WAIT_INTERVAL',waitUntil);}
    const names={'#owner':'owner'};
    const condition='#owner=:owner AND leaseUntil > :now';
    const values={':owner':this.owner,':now':now};
    try{
      await this.ddb.send(new TransactWriteCommand({ClientRequestToken:randomUUID(),TransactItems:[
        reserveSend?{Update:{TableName:this.table,Key:{pk:'ACCOUNT'},UpdateExpression:'SET lastSentAt=:now',
          ConditionExpression:condition+' AND (attribute_not_exists(lastSentAt) OR lastSentAt <= :cutoff)',
          ExpressionAttributeNames:names,ExpressionAttributeValues:{...values,':cutoff':now-SEND_INTERVAL_MS}}}:
          {ConditionCheck:{TableName:this.table,Key:{pk:'ACCOUNT'},ConditionExpression:condition,ExpressionAttributeNames:names,ExpressionAttributeValues:values}},
        {Put:{TableName:this.table,Item:value,ConditionExpression:previous?'revision=:revision':'attribute_not_exists(pk)',
          ...(previous?{ExpressionAttributeValues:{':revision':previous.revision}}:{})}}
      ]}));
      return value;
    }catch{
      // Even if committed, caller must NOT send on an uncertain reservation.
      throw new WorkflowFailure('STATE_UNAVAILABLE');
    }
  }
}
