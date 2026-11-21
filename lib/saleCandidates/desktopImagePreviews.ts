import 'server-only';
import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {signInventoryListKey} from '../inventory/listImageUrls';
import {PHOTO_REGISTRATION_REGION} from '../photoRegistration/types';

/** Web-only presentation of keys already read through the authorized job/inventory boundary. */
export async function signDesktopImage(key:string):Promise<string|null>{
 if(key.startsWith('inventory/'))return signInventoryListKey(key);
 if(!key.startsWith('photo-batches/')||key.includes('..')||!process.env.PHOTO_REGISTRATION_BUCKET_NAME)return null;
 return getSignedUrl(new S3Client({region:process.env.PHOTO_REGISTRATION_AWS_REGION||PHOTO_REGISTRATION_REGION}),new GetObjectCommand({Bucket:process.env.PHOTO_REGISTRATION_BUCKET_NAME,Key:key}),{expiresIn:900});
}
