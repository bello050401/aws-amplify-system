import React,{useRef,useState} from 'react';
import {Modal,Pressable,ScrollView,StyleSheet,Text,TextInput,View} from 'react-native';
import type {InventoryItem,PendingPhoto,UploadedPhoto} from '../domain/inventory';
import {StockSplitError,validateStockSplit,type StockSplitRequest} from '../../../lib/inventory/stockSplitInput';
import {PhotoPicker} from './PhotoPicker';
import {BarcodeScanner} from './BarcodeScanner';
import {colors} from './theme';
export interface StockSplitSaved {source:InventoryItem;split:InventoryItem}
export interface StockSplitPorts {
 newMutationId:()=>string;uploadPhoto:(photo:PendingPhoto)=>Promise<UploadedPhoto>;
 split:(r:StockSplitRequest)=>Promise<StockSplitSaved>;checkBarcode:(barcode:string,excludeId:string)=>Promise<number>;
}
export function StockSplitScreen({item,ports,onCancel,onSaved}:{item:InventoryItem;ports:StockSplitPorts;onCancel:()=>void;onSaved:(result:StockSplitSaved)=>void}){
 const [quantity,setQuantity]=useState('1'),[memo,setMemo]=useState(item.details?.damageNotes??''),[barcode,setBarcode]=useState(item.barcode??''),[photos,setPhotos]=useState<PendingPhoto[]>([]);
 const [scan,setScan]=useState(false),[photoBusy,setPhotoBusy]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirm,setConfirm]=useState(false),[duplicates,setDuplicates]=useState(0),[uncertain,setUncertain]=useState(false),[conflict,setConflict]=useState(false);
 const pending=useRef<StockSplitRequest|null>(null),lock=useRef(false),uploads=useRef(new Map<string,UploadedPhoto>());
 const locked=busy||photoBusy||uncertain||conflict;
 const step=(d:number)=>setQuantity(String(Math.max(1,Math.min(item.quantity,(Number(quantity)||1)+d))));
 async function review(){if(locked||lock.current)return;lock.current=true;setBusy(true);setError('');
  try{validateStockSplit({mutationId:ports.newMutationId(),inventoryId:item.id,expectedUpdatedAt:item.updatedAt,quantity:Number(quantity),damageNotes:memo,barcode,photos:[]},item.quantity);if(photos.length>20)throw Error('写真は20枚まで登録できます。');setDuplicates(barcode.trim()?await ports.checkBarcode(barcode.trim(),item.id):0);setConfirm(true);}
  catch(e){setError((e as Error).message);}finally{lock.current=false;setBusy(false);}
 }
 async function save(){if(lock.current||conflict)return;lock.current=true;setBusy(true);setError('');
  try{
   if(!pending.current){for(const photo of photos)if(!uploads.current.has(photo.id))uploads.current.set(photo.id,await ports.uploadPhoto(photo));
    pending.current={mutationId:ports.newMutationId(),inventoryId:item.id,expectedUpdatedAt:item.updatedAt,quantity:Number(quantity),damageNotes:memo,barcode,photos:photos.map(p=>({storageKey:uploads.current.get(p.id)!.storageKey,type:'DAMAGE'}))};
   }
   onSaved(await ports.split(pending.current));
  }catch(e){const code=e instanceof StockSplitError?e.code:pending.current?'UNCONFIRMED':'INVALID';setError((e as Error).message);setUncertain(code==='UNCONFIRMED');setConflict(code==='CONFLICT');if(code!=='UNCONFIRMED')pending.current=null;setConfirm(false);}
  finally{lock.current=false;setBusy(false);}
 }
 return <View style={s.screen}><View style={s.header}><Pressable accessibilityRole="button" disabled={busy||uncertain} onPress={onCancel} style={s.tap}><Text style={s.link}>キャンセル</Text></Pressable><Text style={s.title}>在庫分け</Text></View>
  <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
   <Text style={s.name}>{item.name}</Text><Text style={s.label}>分ける数量（元の在庫 {item.quantity}点）</Text>
   <View style={s.counter}><Pressable accessibilityRole="button" accessibilityLabel="分ける数量を1減らす" disabled={locked||Number(quantity)<=1} onPress={()=>step(-1)} style={s.step}><Text style={s.title}>−</Text></Pressable><TextInput accessibilityLabel="分ける数量" value={quantity} onChangeText={setQuantity} inputMode="numeric" keyboardType="number-pad" editable={!locked} style={[s.input,{flex:1,textAlign:'center'}]}/><Pressable accessibilityRole="button" accessibilityLabel="分ける数量を1増やす" disabled={locked||Number(quantity)>=item.quantity} onPress={()=>step(1)} style={s.step}><Text style={s.title}>＋</Text></Pressable></View>
   <Text style={s.hint}>元の在庫には {Math.max(0,item.quantity-(Number(quantity)||0))}点を残します。</Text>
   <Text style={s.label}>傷・汚れ・状態のメモ</Text><TextInput accessibilityLabel="傷・汚れ・状態のメモ" value={memo} onChangeText={setMemo} multiline maxLength={10000} editable={!locked} style={[s.input,{minHeight:110}]}/>
   <Text style={s.label}>傷・状態写真</Text><PhotoPicker fixedType="DAMAGE" photos={photos} disabled={locked} onBusy={setPhotoBusy} onAdd={added=>setPhotos(p=>[...p,...added])} onRemove={id=>setPhotos(p=>p.filter(v=>v.id!==id))}/>
   <Text style={s.label}>バーコード</Text><TextInput accessibilityLabel="バーコード" value={barcode} onChangeText={setBarcode} editable={!locked} maxLength={256} style={s.input}/>
   <Pressable accessibilityRole="button" disabled={locked} onPress={()=>setScan(true)} style={s.scan}><Text style={s.link}>バーコードを読み取る</Text></Pressable><Text style={s.hint}>同じ商品のバーコードは共通で登録できます。確認時に重複を調べます。</Text>
   {!!error&&<Text accessibilityRole="alert" style={s.error}>{error}</Text>}
  </ScrollView>
  <View style={s.footer}><Pressable accessibilityRole="button" disabled={busy||photoBusy||conflict} onPress={uncertain?save:review} style={s.primary}><Text style={s.white}>{busy?'確認中…':uncertain?'保存結果を再確認':'内容確認'}</Text></Pressable></View>
  {scan&&<BarcodeScanner onClose={()=>setScan(false)} onRead={value=>{setBarcode(value);setScan(false);}}/>}
  <Modal visible={confirm} transparent animationType="fade" onRequestClose={()=>{if(!busy)setConfirm(false);}}><View style={s.shade}><View style={s.dialog}><Text style={s.title}>在庫を分けますか？</Text><Text style={s.name}>元の在庫：{item.quantity} → {item.quantity-Number(quantity)}点{'\n'}新しい在庫：{quantity}点</Text><Text>{photos.length}枚の傷・状態写真を追加</Text>{duplicates>0&&<Text style={s.hint}>同じバーコードの商品が{duplicates}件あります。共通の番号として登録します。</Text>}{Number(quantity)===item.quantity&&<Text style={s.hint}>全数量を分けるため、元のページは数量0で残ります。</Text>}<View style={s.counter}><Pressable accessibilityRole="button" disabled={busy} onPress={()=>setConfirm(false)} style={s.tap}><Text style={s.link}>戻る</Text></Pressable><Pressable accessibilityRole="button" disabled={busy} onPress={save} style={[s.primary,{flex:1}]}><Text style={s.white}>{busy?'保存中…':'保存'}</Text></Pressable></View></View></View></Modal>
 </View>;
}
const s=StyleSheet.create({screen:{flex:1,backgroundColor:colors.paper},header:{backgroundColor:colors.cream,paddingHorizontal:18,flexDirection:'row',alignItems:'center',gap:24,minHeight:60},tap:{minHeight:48,justifyContent:'center',paddingHorizontal:10},title:{fontSize:20,fontWeight:'600',color:colors.text},link:{fontSize:16,color:colors.blue},body:{padding:18,paddingBottom:30},name:{fontSize:16,lineHeight:25,color:colors.text},label:{fontSize:17,fontWeight:'600',marginTop:22,marginBottom:10,color:colors.text},input:{borderWidth:1,borderColor:colors.border,borderRadius:10,padding:14,minHeight:52,fontSize:17,color:colors.text},counter:{flexDirection:'row',alignItems:'center',gap:12},step:{width:54,height:54,alignItems:'center',justifyContent:'center',borderWidth:1,borderColor:colors.border,borderRadius:12},hint:{fontSize:14,lineHeight:22,color:colors.muted,marginTop:10},scan:{minHeight:52,borderWidth:1,borderColor:colors.blue,borderRadius:12,alignItems:'center',justifyContent:'center',marginTop:12},error:{color:colors.danger,fontSize:16,lineHeight:24,marginTop:16},footer:{padding:16,borderTopWidth:1,borderColor:colors.border,backgroundColor:'white'},primary:{minHeight:56,padding:14,backgroundColor:colors.blue,borderRadius:14,alignItems:'center',justifyContent:'center'},white:{fontSize:18,fontWeight:'600',color:'white'},shade:{flex:1,backgroundColor:'#0006',padding:22,justifyContent:'center'},dialog:{padding:22,gap:18,borderRadius:20,backgroundColor:'white'}});

