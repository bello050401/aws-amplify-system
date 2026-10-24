import React,{useRef,useState} from 'react';
import {KeyboardAvoidingView,Modal,Platform,Pressable,ScrollView,StyleSheet,Text,TextInput,View} from 'react-native';
import type {InventoryItem} from '../domain/inventory';
import {japanToday,SOLD_OUT_MARKETS,validateSoldOut,type SoldOutRequest} from '../../../lib/inventory/soldOutInput';
import {DateField} from './DateField';
import {colors} from './theme';
export interface SoldOutSaved {sold:InventoryItem;source:InventoryItem}
export interface SoldOutPorts {newMutationId:()=>string;sell:(request:SoldOutRequest)=>Promise<SoldOutSaved>}
export class MobileSoldOutError extends Error {constructor(public code:string,message:string){super(message);}}
export function SoldOutScreen({item,ports,onCancel,onSaved}:{item:InventoryItem;ports:SoldOutPorts;onCancel:()=>void;onSaved:(items:SoldOutSaved)=>void}) {
  const [quantity,setQuantity]=useState('1'),[name,setName]=useState(item.name),[date,setDate]=useState(japanToday),[id,setId]=useState(item.details?.externalProductId??''),[market,setMarket]=useState(item.details?.market??''),[price,setPrice]=useState(item.details?.salePrice??'');
  const [busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[conflict,setConflict]=useState(false),[error,setError]=useState(''),[choosing,setChoosing]=useState(false);
  const pending=useRef<SoldOutRequest|null>(null),inflight=useRef(false);
  const locked=busy||uncertain||conflict;
  const submit=async()=>{
    if(inflight.current||conflict)return;setError('');
    try {
      const request=pending.current??{mutationId:ports.newMutationId(),inventoryId:item.id,expectedUpdatedAt:item.updatedAt,quantity:Number(quantity),name,saleEndDate:date,externalProductId:id,market,salePrice:price.trim()?Number(price):null};
      validateSoldOut(request,item.quantity,item.details?.market??'');pending.current=request;
      inflight.current=true;setBusy(true);onSaved(await ports.sell(request));
    }catch(error){
      setError(error instanceof Error?error.message:'登録結果を確認できません。同じ内容で再確認してください。');
      const code=error instanceof MobileSoldOutError?error.code:pending.current?'UNCONFIRMED':'INVALID';
      setUncertain(code==='UNCONFIRMED');setConflict(code==='CONFLICT');if(code!=='UNCONFIRMED')pending.current=null;
    }finally{inflight.current=false;setBusy(false);}
  };
  return <KeyboardAvoidingView style={s.screen} behavior={Platform.OS==='ios'?'padding':undefined}>
    <View style={s.header}><Pressable accessibilityRole="button" disabled={busy||uncertain} onPress={onCancel} style={s.cancel}><Text style={s.link}>キャンセル</Text></Pressable><Text style={s.title}>売切登録</Text><View style={s.cancel}/></View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.body}>
      <Text style={s.label}>売却数量（在庫 {item.quantity}）</Text><TextInput accessibilityLabel="売却数量" value={quantity} onChangeText={setQuantity} keyboardType="number-pad" inputMode="numeric" editable={!locked} style={s.input}/>
      <Text style={s.label}>商品名</Text><TextInput accessibilityLabel="商品名" value={name} onChangeText={setName} multiline maxLength={2000} editable={!locked} style={[s.input,{minHeight:74}]}/>
      <Text style={s.label}>販売終了日</Text><DateField label="販売終了日" value={date} onChange={setDate} disabled={locked}/>
      <Text style={s.label}>ID</Text><TextInput accessibilityLabel="ID" value={id} onChangeText={setId} maxLength={256} editable={!locked} style={s.input}/>
      <Text style={s.label}>市場</Text><Pressable accessibilityRole="button" accessibilityLabel="市場" disabled={locked} onPress={()=>setChoosing(true)} style={s.input}><Text style={s.value}>{market||'未設定'}　⌄</Text></Pressable>
      <Text style={s.label}>販売価格</Text><TextInput accessibilityLabel="販売価格" value={price} onChangeText={setPrice} keyboardType="number-pad" inputMode="numeric" editable={!locked} style={s.input}/>
      <Text style={s.note}>売却分を「売り切れ」に変更します。{Number(quantity)>0&&Number(quantity)<item.quantity?`元の商品には ${item.quantity-Number(quantity)} 個を残します。`:'元の商品ページを更新します。'}</Text>
      {!!error&&<Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    </ScrollView>
    <View style={s.footer}><Pressable accessibilityRole="button" disabled={busy||conflict} onPress={submit} style={[s.submit,(busy||conflict)&&{opacity:.5}]}><Text style={s.submitText}>{busy?'登録を確認中…':uncertain?'登録結果を再確認':'売切登録'}</Text></Pressable></View>
    <Modal visible={choosing} transparent animationType="slide" onRequestClose={()=>setChoosing(false)}><View style={s.shade}><View style={s.sheet}><View style={s.header}><Text style={s.title}>市場</Text><Pressable accessibilityRole="button" onPress={()=>setChoosing(false)} style={s.cancel}><Text style={s.link}>閉じる</Text></Pressable></View><ScrollView>{[...new Set(['',...SOLD_OUT_MARKETS,...(item.details?.market?[item.details.market]:[])])].map(value=><Pressable key={value} accessibilityRole="button" accessibilityState={{selected:market===value}} onPress={()=>{setMarket(value);setChoosing(false);}} style={s.option}><Text style={s.value}>{value||'未設定'}</Text></Pressable>)}</ScrollView></View></View></Modal>
  </KeyboardAvoidingView>;
}
const s=StyleSheet.create({screen:{flex:1,backgroundColor:colors.paper},header:{minHeight:56,paddingHorizontal:12,flexDirection:'row',alignItems:'center',justifyContent:'space-between',backgroundColor:colors.cream},title:{fontSize:18,fontWeight:'600',color:colors.text},cancel:{minWidth:92,minHeight:48,justifyContent:'center'},link:{fontSize:16,color:colors.blue},body:{padding:18,paddingBottom:24},label:{fontSize:16,color:colors.text,marginTop:16,marginBottom:8},input:{borderColor:colors.border,borderWidth:1,borderRadius:10,padding:14,minHeight:52,fontSize:17,color:colors.text},value:{fontSize:17,color:colors.text},note:{fontSize:14,lineHeight:22,color:colors.muted,marginTop:18},error:{fontSize:16,lineHeight:24,color:colors.danger,paddingVertical:14},footer:{padding:16,borderTopWidth:1,borderTopColor:colors.border,backgroundColor:'white'},submit:{minHeight:56,alignItems:'center',justifyContent:'center',borderRadius:14,backgroundColor:colors.blue},submitText:{color:'white',fontSize:18,fontWeight:'600'},shade:{flex:1,backgroundColor:'#0006',justifyContent:'flex-end'},sheet:{maxHeight:'80%',backgroundColor:'white',borderTopLeftRadius:20,borderTopRightRadius:20,overflow:'hidden'},option:{padding:18,borderBottomWidth:1,borderColor:colors.border,minHeight:54}});
