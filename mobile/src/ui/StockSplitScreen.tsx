import React,{useRef,useState} from 'react';
import {Modal,Pressable,ScrollView,StyleSheet,Text,TextInput,View} from 'react-native';
import type {InventoryItem,PendingPhoto,UploadedPhoto} from '../domain/inventory';
import {StockSplitError,validateStockSplit,type StockSplitRequest} from '../../../lib/inventory/stockSplitInput';
import {PhotoPicker} from './PhotoPicker';
import {BarcodeScanner} from './BarcodeScanner';
import {OperationQuantity,OperationConfirmation,operationStyles as s} from './InventoryOperationControls';
export interface StockSplitSaved {source:InventoryItem;split:InventoryItem}
export interface StockSplitPorts {
 newMutationId:()=>string;uploadPhoto:(photo:PendingPhoto)=>Promise<UploadedPhoto>;
 split:(r:StockSplitRequest)=>Promise<StockSplitSaved>;checkBarcode:(barcode:string,excludeId:string)=>Promise<number>;
}
export function StockSplitScreen({item,ports,onCancel,onSaved}:{item:InventoryItem;ports:StockSplitPorts;onCancel:()=>void;onSaved:(result:StockSplitSaved)=>void}){
 const [sourceName,setSourceName]=useState(item.name),[splitName,setSplitName]=useState(item.name);
 const [quantity,setQuantity]=useState('1'),[memo,setMemo]=useState(item.details?.damageNotes??''),[barcode,setBarcode]=useState(item.barcode??''),[photos,setPhotos]=useState<PendingPhoto[]>([]);
 const [scan,setScan]=useState(false),[photoBusy,setPhotoBusy]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirm,setConfirm]=useState(false),[duplicates,setDuplicates]=useState(0),[uncertain,setUncertain]=useState(false),[conflict,setConflict]=useState(false);
 const pending=useRef<StockSplitRequest|null>(null),lock=useRef(false),uploads=useRef(new Map<string,UploadedPhoto>());
 const locked=busy||photoBusy||uncertain||conflict;
 const step=(d:number)=>setQuantity(String(Math.max(1,Math.min(item.quantity,(Number(quantity)||1)+d))));
 async function review(){if(locked||lock.current)return;lock.current=true;setBusy(true);setError('');
  try{validateStockSplit({mutationId:ports.newMutationId(),inventoryId:item.id,expectedUpdatedAt:item.updatedAt,quantity:Number(quantity),sourceName,splitName,damageNotes:memo,barcode,photos:[]},item.quantity);if(photos.length>20)throw Error('写真は20枚まで登録できます。');setDuplicates(barcode.trim()?await ports.checkBarcode(barcode.trim(),item.id):0);setConfirm(true);}
  catch(e){setError((e as Error).message);}finally{lock.current=false;setBusy(false);}
 }
 async function save(){if(lock.current||conflict)return;lock.current=true;setBusy(true);setError('');
  try{
   if(!pending.current){for(const photo of photos)if(!uploads.current.has(photo.id))uploads.current.set(photo.id,await ports.uploadPhoto(photo));
    pending.current={mutationId:ports.newMutationId(),inventoryId:item.id,expectedUpdatedAt:item.updatedAt,quantity:Number(quantity),sourceName,splitName,damageNotes:memo,barcode,photos:photos.map(p=>({storageKey:uploads.current.get(p.id)!.storageKey,type:'DAMAGE'}))};
   }
   onSaved(await ports.split(pending.current));
  }catch(e){const code=e instanceof StockSplitError?e.code:pending.current?'UNCONFIRMED':'INVALID';setError((e as Error).message);setUncertain(code==='UNCONFIRMED');setConflict(code==='CONFLICT');if(code!=='UNCONFIRMED')pending.current=null;setConfirm(false);}
  finally{lock.current=false;setBusy(false);}
 }
 return <View style={s.screen}><View style={s.header}><Pressable accessibilityRole="button" disabled={busy||uncertain} onPress={onCancel} style={s.tap}><Text style={s.link}>キャンセル</Text></Pressable><Text style={s.title}>在庫分け</Text></View>
  <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
   <OperationQuantity label="分ける数量" available={item.quantity} value={quantity} onChange={setQuantity} disabled={locked}/>
   <Text style={s.label}>元の商品名（残り {Math.max(0,item.quantity-(Number(quantity)||0))}点）</Text><TextInput accessibilityLabel="元の商品名" value={sourceName} onChangeText={setSourceName} multiline maxLength={2000} editable={!locked} style={[s.input,{minHeight:74}]}/>
   <Text style={s.label}>新しい商品名（{quantity||0}点）</Text><TextInput accessibilityLabel="新しい商品名" value={splitName} onChangeText={setSplitName} multiline maxLength={2000} editable={!locked} style={[s.input,{minHeight:74}]}/>
   <Text style={s.label}>傷・汚れ・状態のメモ</Text><TextInput accessibilityLabel="傷・汚れ・状態のメモ" value={memo} onChangeText={setMemo} multiline maxLength={10000} editable={!locked} style={[s.input,{minHeight:110}]}/>
   <Text style={s.label}>傷・状態写真</Text><PhotoPicker fixedType="DAMAGE" photos={photos} disabled={locked} onBusy={setPhotoBusy} onAdd={added=>setPhotos(p=>[...p,...added])} onRemove={id=>setPhotos(p=>p.filter(v=>v.id!==id))}/>
   <Text style={s.label}>バーコード</Text><TextInput accessibilityLabel="バーコード" value={barcode} onChangeText={setBarcode} editable={!locked} maxLength={256} style={s.input}/>
   <Pressable accessibilityRole="button" disabled={locked} onPress={()=>setScan(true)} style={s.scan}><Text style={s.link}>バーコードを読み取る</Text></Pressable><Text style={s.hint}>同じ商品のバーコードは共通で登録できます。確認時に重複を調べます。</Text>
   {!!error&&<Text accessibilityRole="alert" style={s.error}>{error}</Text>}
  </ScrollView>
  <View style={s.footer}><Pressable accessibilityRole="button" disabled={busy||photoBusy||conflict} onPress={uncertain?save:review} style={s.primary}><Text style={s.white}>{busy?'確認中…':uncertain?'保存結果を再確認':'内容確認'}</Text></Pressable></View>
  {scan&&<BarcodeScanner onClose={()=>setScan(false)} onRead={value=>{setBarcode(value);setScan(false);}}/>}
  <OperationConfirmation visible={confirm} title="在庫分けの内容確認" busy={busy} onBack={()=>setConfirm(false)} onConfirm={save}><Text style={s.name}>元の商品：{sourceName}{'\n'}{item.quantity-Number(quantity)}点</Text><Text style={s.name}>新しい商品：{splitName}{'\n'}{quantity}点</Text><Text>{photos.length}枚の傷・状態写真を追加</Text>{duplicates>0&&<Text style={s.hint}>同じバーコードの商品が{duplicates}件あります。共通の番号として登録します。</Text>}{Number(quantity)===item.quantity&&<Text style={s.hint}>元のページは数量0で残ります。</Text>}</OperationConfirmation>
 </View>;
}
