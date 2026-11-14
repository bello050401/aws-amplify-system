import React,{useMemo,useState} from 'react';
import {Pressable,Text,View} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {createFixtures,generation,previewToday} from '../../../lib/inventory/analysisUi/fixtures';
import {totalsFromAggregate} from '../../../lib/inventory/salesAggregate';
import {shiftYearMonth} from '../../../lib/inventory/sales';
import type {ProductFact} from '../../../lib/inventory/analysisUi/model';
import {SnapshotStore} from '../domain/snapshot';
import {StaffApp,type StaffAppPorts} from '../ui/StaffApp';
import {photoPreviewImage,previewItems} from './fixture';

const detailImage = photoPreviewImage('分析画面の見本','#9b805e');
function nativeFact(fact:ProductFact):ProductFact {
  return {...fact,imageUrl:fact.imageRef ? detailImage : undefined};
}

export function NativeAnalysisPreview() {
  const [offline,setOffline] = useState(false);
  const [admin,setAdmin] = useState(true);
  const ports = useMemo<StaffAppPorts>(()=>{
    const data = new Map<string,string>();
    const snapshot = new SnapshotStore({
      getItem:async key=>data.get(key)??null,
      setItem:async (key,value)=>{data.set(key,value);},
      removeItem:async key=>{data.delete(key);},
    },'analysis-preview','fixture');
    const {ports:fixture} = createFixtures('generation-race');
    return {
      online:async()=>!offline,newMutationId:()=> 'fixture-only',
      snapshot,loadInventory:async()=>previewItems,
      loadDetail:async id=>({
        ...previewItems.find(item=>item.id===id)??previewItems[0],
        id,name:id.startsWith('bench') ? 'オーク無垢材 ベンチ 木座 ナチュラル 幅120cm 国内家具メーカー仕様' : '分析画面の商品詳細見本',
        thumbnailUrl:detailImage,photosComplete:true,
      }),
      save:async()=>{throw new Error('画面確認用のデータです。');},
      loadInventoryValue:async month=>{
        const result = await fixture.load({target:'inventory',...(month ? {daily:month+'-01'} : {})});
        return result.status==='ok' ? {status:'ok',value:result.inventoryValue} : {status:result.status==='error'?'error':'missing'};
      },
      loadSales:async (year,month)=>{
        const totals = totalsFromAggregate({yearMonth:year+'-'+month,count:8,totalSales:332000,totalCost:100000,totalPurchase:100000,totalProfit:232000,totalShipping:0},year,month);
        return {view:{year,month,status:'ok',totals,aggregateGeneration:generation,aggregateRebuiltAt:'2026-11-14T03:00:00.000Z',trend:Array.from({length:12},(_,index)=>({
          ...shiftYearMonth(year,month,index-11),status:'ok' as const,totalSales:332000,totalGrossProfit:232000,
        }))},forecast:null,forecastUnavailable:false,items:[]};
      },
      analysisToday:previewToday,
      renderSaleOperation:(operation,close)=><View style={{padding:16,gap:12}}>
        <Text accessibilityRole="header">{operation==='purchases'?'売却管理':'請求書発行'}（操作確認用）</Text>
        <Pressable accessibilityRole="button" onPress={close}><Text>戻る</Text></Pressable>
      </View>,
      analysis:{
        load:fixture.load,
        async drill(request) {
          const result = await fixture.drill(request);
          if(result.status !== 'ok') return result;
          return {...result,items:result.items.map(item=>item.type==='record'
            ? {type:'record' as const,record:nativeFact(item.record)}
            : {type:'group' as const,group:{...item.group,representative:nativeFact(item.group.representative)}})};
        },
      },
    };
  },[offline]);
  return <SafeAreaProvider><StaffApp ports={ports} offline={offline} preview canIssueDocuments={admin}
    features={{sales:true,ecListing:false}} previewAccount={admin?'管理者':'スタッフ'}
    onTogglePreviewAccount={()=>setAdmin(value=>!value)} onToggleOffline={()=>setOffline(value=>!value)}/></SafeAreaProvider>;
}
