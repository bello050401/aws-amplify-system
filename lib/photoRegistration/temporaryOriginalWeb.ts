import "server-only";
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {S3Client} from '@aws-sdk/client-s3';
import {getWebTrustedClaims} from './webAdapter';
import {resolveActorContext} from './auth';
import {TemporaryOriginals} from './temporaryOriginals';
export async function temporaryOriginalWeb(){
 const claims=await getWebTrustedClaims();if(!claims)return null;
 const actor=resolveActorContext(claims,{photoDeviceGroupDeployed:false});
 if(!actor.ok||!['STAFF','ADMIN'].includes(actor.value.role))return null;
 const table=process.env.PHOTO_REGISTRATION_TABLE_NAME,bucket=process.env.PHOTO_REGISTRATION_BUCKET_NAME;
 if(!table||!bucket)return null;
 const region=process.env.PHOTO_REGISTRATION_AWS_REGION||'us-west-2';
 return new TemporaryOriginals({db:DynamoDBDocumentClient.from(new DynamoDBClient({region})),s3:new S3Client({region}),table,bucket,auth:{photoDeviceGroupDeployed:false}});
}
