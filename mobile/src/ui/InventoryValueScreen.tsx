import React,{useEffect,useState} from 'react';
import {ActivityIndicator,Pressable,ScrollView,StyleSheet,Text,View} from 'react-native';
import Svg,{Circle,Text as SvgText} from 'react-native-svg';
import {donutSegments,type InventoryValue,type InventoryValueView} from '../../../lib/inventory/inventoryValue';
import {inventoryMonthOptions} from '../../../lib/inventory/inventoryValueCalendar';
import {formatJstDateTime} from '../../../lib/inventory/sales';

const yen=(n:number)=>'¥'+n.toLocaleString('ja-JP');
function Breakdown({value:v,metric}:{value:InventoryValue;metric:'amount'|'quantity'}) {
  const amount=metric==='amount',total=amount?v.total:v.quantity;
  const title=amount?'在庫金額の割合':'在庫数量の割合';
  const display=(n:number)=>amount?yen(n):n.toLocaleString('ja-JP')+'点';
  return <View style={s.card}>
    <Text accessibilityRole="header" style={s.title}>{title}</Text>
    <View style={{alignItems:'center'}}><Svg width={240} height={240} viewBox="0 0 120 120" accessibilityLabel={title+'・カテゴリ別円グラフ'} accessibilityRole="image">
      <Circle cx={60} cy={60} r={45} fill="none" stroke="#eef1ef" strokeWidth={16}/>
      {donutSegments(v.groups,metric).map(g=><Circle key={g.key} cx={60} cy={60} r={45} fill="none" stroke={g.color} strokeWidth={16} strokeDasharray={[g.length/100*2*Math.PI*45,(100-g.length)/100*2*Math.PI*45]} strokeDashoffset={-g.offset/100*2*Math.PI*45} rotation={-90} origin="60,60"/>)}
      <SvgText x={60} y={56} textAnchor="middle" fill="#66736d" fontSize={5}>{amount?'在庫金額':'在庫数量'}</SvgText>
      <SvgText x={60} y={68} textAnchor="middle" fill="#264e47" fontSize={amount?8:11} fontWeight="600">{display(total)}</SvgText>
    </Svg></View>
    <View>{v.groups.map((g,i)=><View key={g.key} style={[s.row,i===v.groups.length-1&&{borderBottomWidth:0}]}>
      <View style={[s.dot,{backgroundColor:g.color}]}/>
      <View style={{flex:1}}><Text style={s.label}>{g.label}</Text>{amount&&<Text style={s.date}>{g.quantity.toLocaleString()}点</Text>}</View>
      <View style={{alignItems:'flex-end'}}><Text style={s.amount}>{display(g[metric])}</Text><Text style={s.date}>{total?(g[metric]/total*100).toFixed(1):'0.0'}%</Text></View>
    </View>)}</View>
  </View>;
}
export function InventoryValueScreen({load,offline}:{load:(month?:string)=>Promise<InventoryValueView>;offline:boolean;onOpen:(id:string)=>void}) {
  const [month,setMonth]=useState<string>();
  const [data,setData]=useState<InventoryValueView|null>(null),[retry,setRetry]=useState(0);
  useEffect(()=>{let active=true;setData(null);if(offline)return()=>{active=false;};void load(month).then(v=>{if(active)setData(v);}).catch(()=>{if(active)setData({status:'error'});});return()=>{active=false;};},[load,offline,retry,month]);
  const v=data?.status==='ok'?data.value:null;
  return <ScrollView contentContainerStyle={s.body}>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{gap:8}}>{[undefined,...inventoryMonthOptions()].map(m=><Pressable key={m??'current'} accessibilityRole="button" accessibilityState={{selected:month===m}} onPress={()=>setMonth(m)} style={[s.month,month===m&&s.monthSelected]}><Text style={{color:month===m?'white':'#264e47',fontWeight:'600'}}>{m?m.replace('-','年')+'月末':'現在の在庫'}</Text></Pressable>)}</ScrollView>
    {offline?<Text style={s.note}>通信できる状態で在庫金額を確認してください。</Text>:!data?<ActivityIndicator accessibilityLabel="在庫金額を読み込み中"/>:!v?<View style={s.card}><Text style={s.title}>{data.status==='missing'?'在庫金額はまだ集計されていません':'在庫金額を取得できませんでした'}</Text><Text style={s.note}>在庫が0円という意味ではありません。</Text><Pressable accessibilityRole="button" onPress={()=>setRetry(n=>n+1)} style={s.button}><Text style={s.buttonText}>再読み込み</Text></Pressable></View>:<>
      <View><Text style={s.note}>{v.month?v.month.replace('-','年')+'月末の在庫金額':'集計時点の在庫金額'}</Text><Text style={s.total}>{yen(v.total)}</Text><Text style={s.note}>在庫数量 {v.quantity.toLocaleString()}点</Text><Text style={s.date}>{formatJstDateTime(v.asOf)} 時点 · {v.month?'月末の記録':'12時間ごとに自動集計'}</Text></View>
      <Breakdown value={v} metric="amount"/>
      <Breakdown value={v} metric="quantity"/>
      {v.unpricedCount>0&&<Text style={s.date}>購入単価を確認できない{v.unpricedCount}商品は金額に含めず、数量のみ計上しています。</Text>}
    </>}
  </ScrollView>;
}
const s=StyleSheet.create({
  body:{padding:18,paddingBottom:36,gap:18,maxWidth:720,width:'100%',alignSelf:'center'},card:{backgroundColor:'white',borderColor:'#e1e7e3',borderWidth:1,borderRadius:16,padding:18,gap:8},
  total:{fontSize:36,fontWeight:'700',color:'#264e47',marginVertical:7,fontVariant:['tabular-nums']},title:{fontSize:17,fontWeight:'700',color:'#263c35'},note:{fontSize:14,lineHeight:22,color:'#64716b'},date:{fontSize:11,lineHeight:18,color:'#7b867f',marginTop:4},row:{flexDirection:'row',alignItems:'center',gap:10,paddingVertical:11,borderBottomWidth:1,borderColor:'#edf0ee'},dot:{width:10,height:10,borderRadius:5},label:{fontSize:15,color:'#30433a'},amount:{fontSize:19,color:'#263c35',fontWeight:'600',fontVariant:['tabular-nums']},button:{minHeight:44,justifyContent:'center',paddingVertical:8},buttonText:{fontSize:14,lineHeight:21,color:'#285c51',fontWeight:'600'},month:{minHeight:44,paddingHorizontal:16,justifyContent:'center',borderRadius:10,backgroundColor:'#eef2ef'},monthSelected:{backgroundColor:'#264e47'}
});
