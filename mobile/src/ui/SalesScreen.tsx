import {DocumentEntry} from "./DocumentEntry";
import React,{useEffect,useRef,useState} from "react";
import {ActivityIndicator,Modal,Pressable,ScrollView,StyleSheet,Text,View} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import type {SalesSummaryView} from "../../../lib/inventory/salesViewTypes";
import {calculateItemGrossProfit,nowInJst,shiftYearMonth,formatJstDateTime,type SalesTargetItem} from "../../../lib/inventory/sales";
import {SalesTrendChart} from "./SalesTrendChart";
import {colors} from "./theme";
export interface SalesResponse {view:SalesSummaryView;forecast:null|{averageDailySales:number;projectedMonthEndSales:number;month:number;today:number;totalDaysInMonth:number};forecastUnavailable:boolean;items?:SalesTargetItem[]}
export function SalesScreen({load,offline,onOpen,canIssueDocuments=false}:{load:(year:number,month:number,items?:boolean)=>Promise<SalesResponse>;offline:boolean;onOpen:(id:string)=>void;canIssueDocuments?:boolean}){
  const [document,setDocument]=useState<"invoice"|null>(null);
  const today=nowInJst(new Date());const [month,setMonth]=useState({year:today.year,month:today.month});
  const [data,setData]=useState<SalesResponse|null>(null);const [error,setError]=useState("");const [busy,setBusy]=useState(false);
  const version=useRef(0);
  const [picker,setPicker]=useState(false);const [pickYear,setPickYear]=useState(today.year);
  const refresh=async()=>{const attempt=++version.current;setError("");setData(null);if(offline){setBusy(false);setError("【圏外です】売上は通信できる状態で確認してください。");return;}setBusy(true);
    try{const value=await load(month.year,month.month);if(attempt===version.current)setData(value);}catch{if(attempt===version.current)setError("売上を取得できませんでした。再読み込みしてください。");}finally{if(attempt===version.current)setBusy(false);}};
  useEffect(()=>{void refresh();return()=>{version.current++;};},[month.year,month.month,offline,load]);
  const yen=(n:number)=>"¥"+Math.round(n).toLocaleString("ja-JP");
  const view=data?.view;const totals=view?.totals;const change=(delta:number)=>setMonth(value=>shiftYearMonth(value.year,value.month,delta));
  const button=(label:string,action:()=>void,disabled=false)=><Pressable accessibilityRole="button" disabled={disabled} onPress={action} style={[s.button,disabled&&{opacity:.4}]}><Text style={s.link}>{label}</Text></Pressable>;
  const tile=(label:string,value:string)=><View style={s.tile} key={label}><Text style={s.tileLabel}>{label}</Text><Text style={s.amount}>{value}</Text></View>;
  if(document&&canIssueDocuments)return <DocumentEntry onClose={()=>setDocument(null)}/>;
  return <View style={s.screen}>
    <View style={s.controls}>
      <View style={s.row}>
        <Pressable accessibilityRole="button" accessibilityLabel="前月" disabled={month.year===2000&&month.month===1} onPress={()=>change(-1)} style={s.arrow}><Ionicons name="chevron-back" size={22} color="#374151"/></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={month.year+"年"+month.month+"月を選択"} accessibilityState={{expanded:picker}} onPress={()=>{setPickYear(month.year);setPicker(true);}} style={s.monthButton}><Text style={s.monthTitle}>{month.year}年{month.month}月</Text><Ionicons name="chevron-down" size={17} color="#6b7280"/></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="翌月" disabled={month.year===today.year+1&&month.month===12} onPress={()=>change(1)} style={s.arrow}><Ionicons name="chevron-forward" size={22} color="#374151"/></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="売上を再読み込み" disabled={busy||offline} onPress={()=>{void refresh();}} style={s.reload}><Ionicons name="refresh-outline" size={21} color="#4b5563"/></Pressable>
      </View>

    </View>
    <ScrollView contentContainerStyle={s.body}>
      {busy?<ActivityIndicator accessibilityLabel="売上を読み込み中"/>:null}{error?<Text accessibilityRole="alert" style={s.error}>{error}</Text>:null}
      {view&&<>
        <Text style={s.hint}>{view.status==="ok"&&view.aggregateRebuiltAt?"集計："+formatJstDateTime(view.aggregateRebuiltAt)+" JST":view.status==="missing"?"この月は未集計です。売上が0円という意味ではありません。":"集計を取得できませんでした。"}</Text>
        {data.forecast&&<View style={s.section}><Text style={s.heading}>今月の売上着地予測</Text><View style={s.tiles}>{tile("1日平均売上",yen(data.forecast.averageDailySales))}{tile("月末の売上予測",yen(data.forecast.projectedMonthEndSales))}</View><Text style={s.hint}>{data.forecast.month}月{data.forecast.today}日時点 / {data.forecast.totalDaysInMonth}日間</Text></View>}
        {data.forecastUnavailable?<Text style={s.hint}>集計日時を確認できないため、着地予測は算出できません。</Text>:null}
        <View style={s.tiles}>{totals&&[["売上高",yen(totals.totalSales)],["原価",yen(totals.totalCost)],["粗利益",yen(totals.totalProfit)],["原価率",totals.costRate.toFixed(1)+"%"],["送料（参考）",yen(totals.totalShipping)],["販売件数",totals.count+"件"],["平均販売単価",yen(totals.averageSalePrice)]].map(([label,value])=>tile(label,view.status==="ok"?value:"—"))}</View>
        <Text style={s.note}>送料は原価に含みません。</Text>
        <View style={s.chart}><Text style={s.heading}>直近12ヶ月の推移</Text><SalesTrendChart key={month.year+"-"+month.month} points={view.trend}/></View>
      </>}
      {canIssueDocuments&&<View style={s.section}><Text style={s.heading}>帳票発行</Text>{button("請求書発行",()=>setDocument("invoice"),offline)}</View>}
    </ScrollView>
    <Modal visible={picker} transparent animationType="slide" onRequestClose={()=>setPicker(false)}>
      <View style={s.shade}><Pressable accessibilityRole="button" accessibilityLabel="年月選択を閉じる" style={StyleSheet.absoluteFill} onPress={()=>setPicker(false)}/>
        <View style={s.dialog}><View style={s.row}><Text style={s.dialogTitle}>年月を選択</Text>{button("閉じる",()=>setPicker(false))}</View>
          <Text style={s.heading}>年を選択</Text>
          <ScrollView style={{maxHeight:144}}><View style={s.pickerGrid}>{Array.from({length:today.year-1998},(_,i)=>today.year+1-i).map(year=><Pressable key={year} accessibilityRole="button" accessibilityLabel={year+"年"} accessibilityState={{selected:pickYear===year}} onPress={()=>setPickYear(year)} style={[s.pickerCell,pickYear===year&&s.selected]}><Text style={[s.pickerText,pickYear===year&&s.white]}>{year}</Text></Pressable>)}</View></ScrollView>
          <Text style={s.heading}>{pickYear}年 — 月を選択</Text>
          <View style={s.pickerGrid}>{Array.from({length:12},(_,i)=>i+1).map(m=><Pressable key={m} accessibilityRole="button" accessibilityLabel={m+"月"} accessibilityState={{selected:pickYear===month.year&&m===month.month}} onPress={()=>{setMonth({year:pickYear,month:m});setPicker(false);}} style={[s.pickerCell,pickYear===month.year&&m===month.month&&s.selected]}><Text style={[s.pickerText,pickYear===month.year&&m===month.month&&s.white]}>{m}月</Text></Pressable>)}</View>
        </View>
      </View>
    </Modal>
  </View>;
}
const s=StyleSheet.create({
  screen:{flex:1,backgroundColor:"white"},controls:{paddingHorizontal:16,paddingTop:4,paddingBottom:8,borderBottomWidth:1,borderColor:"#e5e7eb",backgroundColor:"white"},
  row:{flexDirection:"row",alignItems:"center",justifyContent:"space-between"},arrow:{width:44,height:44,alignItems:"center",justifyContent:"center"},monthButton:{minHeight:44,flex:1,flexDirection:"row",gap:8,alignItems:"center",justifyContent:"center"},monthTitle:{fontSize:20,fontWeight:"700",color:"#111827"},
  selected:{backgroundColor:"#111827"},white:{color:"white"},reload:{height:44,width:44,alignItems:"center",justifyContent:"center"},
  body:{padding:16,gap:14,paddingBottom:30,width:"100%",maxWidth:800,alignSelf:"center"},section:{gap:8},button:{minHeight:44,padding:10,borderWidth:1,borderColor:"#d1d5db",borderRadius:5,alignItems:"center",justifyContent:"center"},link:{color:colors.blue,fontSize:14,lineHeight:21},error:{color:colors.danger,lineHeight:22},hint:{fontSize:12,color:"#6b7280",lineHeight:18},note:{fontSize:11,color:"#6b7280",marginTop:-9},heading:{fontSize:13,fontWeight:"700",color:"#6b7280"},amount:{fontSize:18,fontWeight:"700",color:"#111827",fontVariant:["tabular-nums"]},
  tiles:{flexDirection:"row",flexWrap:"wrap",gap:1,padding:1,backgroundColor:"#e5e7eb"},tile:{flexBasis:"48%",flexGrow:1,backgroundColor:"white",paddingHorizontal:12,paddingVertical:9,gap:3},tileLabel:{fontSize:11,color:"#6b7280",lineHeight:15},chart:{gap:12,borderWidth:1,borderColor:"#e5e7eb",padding:12},item:{gap:6,borderBottomWidth:1,borderColor:colors.border,paddingVertical:14},
  shade:{flex:1,backgroundColor:"#0005",justifyContent:"flex-end"},dialog:{backgroundColor:"white",padding:20,paddingBottom:30,borderTopLeftRadius:20,borderTopRightRadius:20,gap:12,width:"100%",maxWidth:500,alignSelf:"center"},dialogTitle:{fontSize:18,fontWeight:"700"},pickerGrid:{flexDirection:"row",flexWrap:"wrap",gap:4},pickerCell:{width:"24%",minHeight:44,justifyContent:"center",alignItems:"center",backgroundColor:"#f3f4f6",borderRadius:5},pickerText:{fontSize:16,color:"#374151"}
});
