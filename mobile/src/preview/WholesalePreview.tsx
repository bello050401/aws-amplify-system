import {photoPreviewImage} from './fixture';
import React,{useMemo,useState} from 'react';
import {Pressable,Text,View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {WholesaleScreen} from '../ui/WholesaleScreen';
import type {WholesalePorts,WholesaleRow} from '../domain/wholesale';

export function WholesalePreview(){
 const [open,setOpen]=useState(false),[offline,setOffline]=useState(false);
 const ports=useMemo<WholesalePorts>(()=>{
  let attempt=0;const applied=new Set<string>();
  const rows:WholesaleRow[]=Array.from({length:8},(_,i)=>({id:`fixture-${i}`,updatedAt:'2026-11-28T00:00:00Z',displayId:`BELLO-${i+1}`,name:i===0?'カリモク家具 オーク無垢材 ダイニングチェア 2脚セット 長い商品タイトルを省略せず確認できる業販一覧の表示見本':`業販確認用 ダイニング家具 ${i+1}`,imageUrl:i===0?photoPreviewImage('業販確認用 チェア','#9b6b53'):null,purchaseAmount:i===2?null:12000+i*1370-(i===3?0:1000+i*100),shipping:i===3?0:1000+i*100,totalCost:i===2?null:12000+i*1370,sellingDays:i===4?null:i*11,quantity:i+1,saleStartDate:'2026-11-01',alreadyWholesale:i===7}));
  return {newMutationId:()=>`fixture-mutation-${Date.now()}`,load:async()=>{await new Promise(resolve=>setTimeout(resolve,350));return {items:rows.map(i=>({...i,alreadyWholesale:i.alreadyWholesale||applied.has(i.id)})),canEdit:true,snapshotVersion:'fixture-snapshot',checkedAt:null,unlinkedCount:0,ambiguousCount:0,warnings:[]};},save:async(request)=>{await new Promise(resolve=>setTimeout(resolve,900));attempt++;return {results:request.items.map((item,index)=>{const success=attempt>1||index!==1;if(success)applied.add(item.id);return {id:item.id,status:success?'saved':'failed',message:success?'「業者間」を追加しました。既存カテゴリを保持しています。':'商品が更新されています。再読み込み後に選び直してください。'};})};}};
 },[]);
 return <SafeAreaView style={{flex:1,backgroundColor:'#F8F6F1'}}><View style={{padding:8,flexDirection:'row',gap:16}}><Text>操作確認用・実在庫に反映しません</Text><Pressable accessibilityRole="button" onPress={()=>setOffline(v=>!v)}><Text>{offline?'通信を戻す':'圏外を試す'}</Text></Pressable></View>{open?<WholesaleScreen ports={ports} offline={offline} onClose={()=>setOpen(false)}/>:<View style={{padding:24}}><Text style={{fontSize:22,marginBottom:24}}>HOME</Text><Pressable accessibilityRole="button" accessibilityLabel="業販" onPress={()=>setOpen(true)} style={{minHeight:70,padding:20,backgroundColor:'#263D3C',borderRadius:16}}><Text style={{color:'white',fontSize:20}}>業販</Text></Pressable></View>}<View style={{padding:16,borderTopWidth:1,borderColor:'#DBE2DA'}}><Text>ホーム　　　在庫一覧　　　出庫　　　売上</Text></View></SafeAreaView>;
}
