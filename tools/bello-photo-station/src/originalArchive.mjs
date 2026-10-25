import {createHash} from 'node:crypto';
import {describeFile} from './client.mjs';
import {readSourceExpiry,REDO_WINDOW_MS} from './retention.mjs';
export const originalArchiveId=(device,session,asset)=>createHash('sha256').update(JSON.stringify([device,session,asset])).digest('hex');
export async function archiveOriginalSources({api,sessionId,deviceId,sources,outputRoot,onStatus=()=>{}}){
 const expiry=await readSourceExpiry(outputRoot);
 if(!expiry)throw Error('取込日時を確認できません。原本は削除せず、取込履歴を確認してください。');
 const importedAt=new Date(expiry-REDO_WINDOW_MS).toISOString();
 for(let i=0;i<sources.length;i++){
  const source=sources[i];
  onStatus('編集前写真をクラウドへ一時保管中 '+(i+1)+'/'+sources.length);
  const original={...await describeFile(source.sourcePath,'application/octet-stream'),fileName:source.fileName};
  const result=await api.call('requestTemporaryOriginal',{sessionId,clientAssetId:source.clientAssetId,importedAt,original});
  if(result.status==='UPLOAD'){
   await api.upload(result.upload,source.sourcePath);
   const done=await api.call('completeTemporaryOriginal',{id:result.id});
   if(done.status!=='READY')throw Error('編集前写真の保存を確認できません。');
  }else if(result.status!=='READY')throw Error('編集前写真はクラウドに保管されていません。保管期限と取込履歴を確認して再実行してください。');
 }
 return{status:'ORIGINALS_ARCHIVED',uploaded:sources.map(x=>({fileName:x.fileName})),editFailures:[],uploadFailures:[]};
}
