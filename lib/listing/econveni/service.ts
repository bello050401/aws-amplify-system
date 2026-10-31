import 'server-only';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {getListingDraftForInventory,getChannelListing} from '../service';
import {getInventoryDetail} from '@/lib/inventory/queries';
import {getYahooAuctionPreparationAction} from '@/app/actions/yahooAuctionPreparation';
import {resolveListingImageDownloadUrl} from '../mercari/csv/buildExportRows';
import {EconveniHttpSession,EconveniHttpError,type UploadImage} from './httpSession';
import {econveniCredentialStore} from './credentials';
import {econveniStore} from './runtimeStore';
import {withEconveniAccount} from './accountWorkflow';
import {EconveniWorkflowError,type EconveniWorkflow,type EconveniChannel} from './workflowStore';
import {runEconveniSave} from './saveWorkflow';
import {runEconveniCommand} from './commandWorkflow';
import {prepareEconveniProduct,EconveniPreparationError} from './mapping';
import type {EcReview} from '../ecManagement';
import {manualWriteRestriction} from './manualWriteGuard';

export type EconveniSaveResult={status:'DONE'|'WAIT'|'BLOCKED';message:string;productId?:string;nextAt?:number};
export function econveniFailure(error:unknown):EconveniSaveResult{
  if(error instanceof EconveniPreparationError)return {status:'BLOCKED',message:error.message};
  if(error instanceof EconveniWorkflowError&&error.code==='WAIT_INTERVAL')return {status:'WAIT',nextAt:error.readyAt,message:'eコンビニへの送信間隔を空けています。'};
  const messages:Record<string,string>={AUTH_REQUIRED:'eコンビニの接続設定からログインを確認してください。',ACCESS_DENIED:'eコンビニ側で接続が拒否されました。設定から接続を確認してください。',ADDITIONAL_AUTH:'eコンビニで追加認証が必要です。自動送信を停止しています。',BUSY_OR_STOPPED:'別の商品の処理中、または接続の確認が必要です。少し待って再確認してください。',VERIFY_REQUIRED:'前回の処理結果を確認できません。重複送信を防ぐため、再送せず結果を再確認してください。',CONTRACT_CHANGED:'eコンビニの保存項目・画像または画面形式を確認できませんでした。出品は実行していません。'};
  const code=error instanceof EconveniHttpError||error instanceof EconveniWorkflowError?error.code:'';
  return {status:'BLOCKED',message:messages[code]??'eコンビニの処理結果を確認できませんでした。再送せず、保存結果を確認してください。'};
}
async function source(id:string){
  const [draft,item,shops,yahoo]=await Promise.all([getListingDraftForInventory(id),getInventoryDetail(id),getChannelListing(id,'MERCARI_SHOPS'),getYahooAuctionPreparationAction(id)]);
  if(!draft||!item||!yahoo.ok)throw new EconveniPreparationError('共通の商品情報を保存し、在庫情報を確認してください。');
  if(!yahoo.context.canPrepare)throw new EconveniPreparationError('出品対象のカテゴリ・在庫数量・販売状況を確認してください。');
  return prepareEconveniProduct(draft,item.quantity,item.displayId||id,shops,yahoo.context.saved);
}
async function images(refs:Awaited<ReturnType<typeof source>>['refs']):Promise<UploadImage[]>{
  const result:UploadImage[]=[];let total=0;
  for(const ref of refs){
    const target=await resolveListingImageDownloadUrl(ref);
    if(!target)throw new EconveniPreparationError('選択した画像が見つかりません。画像を選び直して保存してください。');
    const response=await fetch(target,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok||!response.body)throw new EconveniHttpError('NETWORK');
    const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
    try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;total+=chunk.value.length;
      if(size>20*1024*1024||total>80*1024*1024)throw new EconveniPreparationError('画像の容量が大きすぎます。1枚20MB・合計80MB以内で選択してください。');parts.push(chunk.value);
    }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    let bytes=Buffer.concat(parts);const metadata=await sharp(bytes).metadata();
    let mimeType:UploadImage['mimeType'];
    if(metadata.format==='jpeg')mimeType='image/jpeg';
    else if(metadata.format==='png')mimeType='image/png';
    else if(metadata.format==='webp'){bytes=await sharp(bytes).rotate().jpeg({quality:95}).toBuffer();mimeType='image/jpeg';}
    else throw new EconveniPreparationError('画像はJPEG・PNG・WebPを選択してください。');
    result.push({bytes,mimeType,filename:`photo-${result.length+1}.${mimeType==='image/png'?'png':'jpg'}`});
  }
  return result;
}
function uniqueOption(form:Awaited<ReturnType<EconveniHttpSession['registrationForm']>>,field:string,label:string){
  const choices=form.fields.find(f=>f.name===field)?.options.filter(o=>o.label.trim()===label)??[];
  if(choices.length!==1)throw new EconveniHttpError('CONTRACT_CHANGED');return choices[0].value;
}
async function saveInSession(id:string,store:ReturnType<typeof econveniStore>,session:EconveniHttpSession,prepared:Awaited<ReturnType<typeof source>>){
  const current=await store.read();
  // Reconciliation never re-uploads images or creates another option/product.
  if(current&&['PENDING','VERIFY_REQUIRED'].includes(current.save.state))return runEconveniSave(store,session,{inventoryId:id,fingerprint:prepared.fingerprint,fields:prepared.fields,images:[]});
  if(current?.save.state==='SUCCEEDED'&&current.save.fingerprint===prepared.fingerprint)return current;
  if(!current?.save.productId)await session.assertNoExistingTitle(prepared.fields.products_name);
  const form=await session.registrationForm();
  const templateId=uniqueOption(form,'yahoo_setting_id',prepared.shippingLabel);
  const fields={...prepared.fields,yahoo_setting_id:templateId,yahoo_information_id:uniqueOption(form,'yahoo_information_id','テンプレ'),mercariShops_setting_id:uniqueOption(form,'mercariShops_setting_id','名前配送')};
  await session.preflightSave(id,fields,prepared.refs.length);
  const files=await images(prepared.refs);
  return runEconveniSave(store,session,{inventoryId:id,fingerprint:prepared.fingerprint,fields,images:files},async()=>({...fields,yahoo_setting_id:await session.ensureYahooOption(templateId,prepared.option)}));
}
export async function saveEconveniDraft(id:string):Promise<EconveniSaveResult>{
  try{
    const restriction=await manualWriteRestriction(id);if(restriction)return {status:'BLOCKED',message:restriction};
    const prepared=await source(id),store=econveniStore(id),session=new EconveniHttpSession();
    const state=await withEconveniAccount(store,session,()=>econveniCredentialStore.credentials(),()=>saveInSession(id,store,session,prepared));
    if(state.save.state!=='SUCCEEDED')throw new EconveniWorkflowError('VERIFY_REQUIRED');
    if(state.save.fingerprint!==prepared.fingerprint)return {status:'BLOCKED',productId:state.save.productId,message:'前回の保存を確認しました。今回の変更を反映するには、もう一度下書きを保存してください。'};
    return {status:'DONE',productId:state.save.productId,message:'BELLO・eコンビニに商品と画像を保存しました。出品準備完了です。'};
  }catch(e){return econveniFailure(e);}
}
function display(state:EconveniWorkflow,channel:EconveniChannel){
  const fields=state.save.expected?.fields??{};
  return {title:fields[channel==='YAHOO'?'products_name':'mercariShops_name']??'',price:Number(fields[channel==='YAHOO'?'products_price':'mercariShops_price']),quantity:Number(fields.products_quantity),imageCount:state.save.expected?.imageHashes.length??0};
}
/** Only explicit per-channel commands. There is no sale detector or cross-channel stop. */
export async function econveniOperation(id:string,channel:EconveniChannel,operation:'PUBLISH'|'STOP',actor:string,token?:string,terms=false):Promise<EcReview>{
  let base:EcReview={inventoryId:id,channel,operation,title:'',status:'BLOCKED',message:'処理を確認できませんでした。'};
  try{
    const restriction=await manualWriteRestriction(id,channel);if(restriction)return {...base,message:restriction};
    const prepared=operation==='PUBLISH'?await source(id):null;
    const store=econveniStore(id),session=new EconveniHttpSession();
    return await withEconveniAccount(store,session,()=>econveniCredentialStore.credentials(),async()=>{
      let state=await store.read();
      if(!token&&prepared)state=await saveInSession(id,store,session,prepared);
      if(!state||state.save.state!=='SUCCEEDED'||!state.save.productId)throw new EconveniPreparationError('eコンビニへの商品保存を確認できません。共通の商品情報で下書きを保存してください。');
      base={...base,...display(state,channel)};
      if(prepared&&state.save.fingerprint!==prepared.fingerprint)throw new EconveniPreparationError('共通の商品情報が変わりました。下書きを保存してから確認し直してください。');
      const own=state.channels[channel];
      const uncertain=['PENDING','VERIFY_REQUIRED'].includes(own.state);
      if(uncertain){
        if(own.operation!==operation)throw new EconveniWorkflowError('VERIFY_REQUIRED');
        const result=await runEconveniCommand(store,session,{inventoryId:id,channel,operation,fingerprint:state.save.fingerprint!,title:base.title,price:base.price!,allowMercariRemoval:true});
        return result.channels[channel].state==='SUCCEEDED'?{...base,status:'DONE',message:'前回の処理結果を確認しました。'}:{...base,message:'処理結果を確認できません。再送せず、eコンビニで結果を確認してください。'};
      }
      if(operation==='PUBLISH'&&own.remoteStatus==='ACTIVE'||operation==='STOP'&&own.remoteStatus==='INACTIVE')return {...base,status:'DONE',message:operation==='PUBLISH'?'すでに出品中です。':'停止済みです。'};
      if(!token){
        const remote=await session.readInventory(id);
        if(remote?.productId!==state.save.productId)throw new EconveniWorkflowError('VERIFY_REQUIRED');
        const observed=remote.channels[channel];
        if(operation==='STOP'&&(observed.state!=='ACTIVE'||own.listingId!==observed.listingId))throw new EconveniWorkflowError('VERIFY_REQUIRED');
        if(operation==='PUBLISH'&&observed.state!=='INACTIVE')throw new EconveniWorkflowError('VERIFY_REQUIRED');
        if(operation==='STOP'){
          // A prior sale can change the stock annotation without changing this listing ID.
          // Confirm the exact current form values, then pin them to this user's approval.
          const {values}=await session.saleProductFields(state.save.productId);
          const title=values[channel==='YAHOO'?'products_name':'mercariShops_name'];
          const price=values[channel==='YAHOO'?'products_price':'mercariShops_price'];
          if(!title||!/^\d+$/.test(price??'')||!/^\d+$/.test(values.products_quantity??''))throw new EconveniWorkflowError('VERIFY_REQUIRED');
          base={...base,title,price:Number(price),quantity:Number(values.products_quantity)};
        }
        if(operation==='PUBLISH'&&(!state.save.expected||!await session.verifySavedProduct(remote,state.save.expected)))throw new EconveniWorkflowError('VERIFY_REQUIRED');
        await session.publicationPreview({channel,operation,productId:state.save.productId,title:base.title,price:base.price!});
        const approval={token:randomUUID(),actor,operation,fingerprint:state.save.fingerprint!,expiresAt:Date.now()+10*60_000,title:base.title,price:base.price,quantity:base.quantity};
        state=await store.commit(state,{...state,approvals:{...state.approvals,[channel]:approval}});
        return {...base,status:'READY',token:approval.token,requiresTerms:channel==='YAHOO'&&operation==='PUBLISH',
          message:operation==='PUBLISH'?'eコンビニの保存内容を確認しました。この販売先に出品します。':channel==='MERCARI_SHOPS'?'メルカリShopsの商品を削除して出品を停止します。':'ヤフオクの出品を停止します。',
          details:operation==='STOP'?['選択した販売先だけを操作します。','BELLOの商品・在庫・他の販売先は変更しません。']:['商品・画像・数量・価格の保存を照合済みです。']};
      }
      const approved=state.approvals?.[channel];
      if(!approved||approved.token!==token||approved.actor!==actor||approved.operation!==operation||approved.fingerprint!==state.save.fingerprint||approved.expiresAt<Date.now())throw new EconveniPreparationError('確認の有効期限が切れたか、内容が変わりました。確認し直してください。');
      if(operation==='STOP'&&approved.title&&typeof approved.price==='number')base={...base,title:approved.title,price:approved.price,quantity:approved.quantity};
      if(channel==='YAHOO'&&operation==='PUBLISH'&&!terms)throw new EconveniPreparationError('ヤフオクのガイドラインへの同意を確認してください。');
      // The common draft may change while the account lease/login is awaited.
      if(prepared&&(await source(id)).fingerprint!==approved.fingerprint)throw new EconveniPreparationError('共通の商品情報が変わりました。下書きを保存してから確認し直してください。');
      const result=await runEconveniCommand(store,session,{inventoryId:id,channel,operation,fingerprint:approved.fingerprint,title:base.title,price:base.price!,allowMercariRemoval:true});
      return result.channels[channel].state==='SUCCEEDED'?{...base,status:'DONE',message:operation==='PUBLISH'?'出品と公開状態を確認しました。':'選択した販売先の停止を確認しました。'}:{...base,message:'送信後の状態を確認できません。重複送信せず、結果を再確認してください。'};
    });
  }catch(e){return {...base,...econveniFailure(e)};}
}
