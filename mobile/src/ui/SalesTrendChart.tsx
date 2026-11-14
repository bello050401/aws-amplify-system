import React,{useState} from 'react';
import {Pressable,StyleSheet,Text,View} from 'react-native';
import Svg,{Circle,Line,Rect,Text as SvgText} from 'react-native-svg';
import type {SalesTrendPoint} from '../../../lib/inventory/salesViewTypes';
import {salesChart,salesTrendLabel} from '../../../lib/inventory/salesChart';

const height=180;
export function SalesTrendChart({points}:{points:SalesTrendPoint[]}) {
  const [width,setWidth] = useState(280);
  const [active,setActive] = useState<number|null>(null);
  const chart = salesChart(points,width,height);
  const selected = active===null ? null : points[active];
  return <View onLayout={event=>setWidth(Math.max(200,event.nativeEvent.layout.width))}>
    <View style={s.legend}>
      <View style={[s.key,{backgroundColor:'#111827'}]}/><Text style={s.label}>売上高</Text>
      <View style={[s.key,{backgroundColor:'#10b981'}]}/><Text style={s.label}>粗利益</Text>
    </View>
    <View style={{height}}>
      <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} accessibilityLabel="直近12ヶ月の売上高・粗利益の棒グラフ">
        <Line x1={chart.padding.left} x2={width-chart.padding.right} y1={chart.zero} y2={chart.zero} stroke="#d1d5db"/>
        {points.map((point,index)=><React.Fragment key={`${point.year}-${point.month}`}>
          <SvgText x={chart.xFor(index)} y={height-6} textAnchor="middle" fill="#526359" fontSize={10}>
            {point.month===1 ? `${String(point.year).slice(-2)}/1` : String(point.month)}
          </SvgText>
          {point.status==='ok' ? <>
            <Rect {...chart.bar(index,point.totalSales,'sales')} fill="#111827"/>
            <Rect {...chart.bar(index,point.totalGrossProfit,'profit')} fill="#10b981"/>
          </> : <Circle cx={chart.xFor(index)} cy={chart.zero} r={3} fill="white" stroke={point.status==='error' ? '#dc2626' : '#9ca3af'} strokeWidth={1.5}/>}
        </React.Fragment>)}
      </Svg>
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {points.map((point,index)=><Pressable key={`${point.year}-${point.month}`}
          accessibilityRole="button" accessibilityLabel={salesTrendLabel(point)} onPress={()=>setActive(index)} onFocus={()=>setActive(index)}
          style={{position:'absolute',left:chart.xFor(index)-chart.slot/2,width:chart.slot,top:chart.padding.top,bottom:chart.padding.bottom,backgroundColor:active===index?'#263c3517':'transparent'}}/>)}
      </View>
    </View>
    <Text style={s.readout} accessibilityLiveRegion="polite">{selected ? salesTrendLabel(selected) : 'グラフの月を選ぶと金額を表示します'}</Text>
  </View>;
}

export function SalesTrendDisclosure({points}:{points:SalesTrendPoint[]}) {
  const [expanded,setExpanded] = useState(false);
  return <View style={s.card}>
    <Pressable accessibilityRole="button" aria-expanded={expanded} accessibilityState={{expanded}} onPress={()=>setExpanded(value=>!value)} style={s.toggle}>
      <Text style={s.title}>直近12ヶ月の推移</Text><Text aria-hidden>{expanded ? '▴' : '▾'}</Text>
    </Pressable>
    {expanded && <SalesTrendChart points={points}/>}
  </View>;
}
const s=StyleSheet.create({
  card:{borderColor:'#e0e8e2',borderWidth:1,borderRadius:12,paddingHorizontal:12},
  toggle:{minHeight:44,flexDirection:'row',alignItems:'center',justifyContent:'space-between'},
  title:{fontSize:14,fontWeight:'700',color:'#263c35'},legend:{flexDirection:'row',alignItems:'center',gap:7,marginBottom:8},
  key:{width:9,height:9},label:{fontSize:12,color:'#4b5563',marginRight:10},
  readout:{fontSize:12,lineHeight:18,color:'#4b5563',minHeight:40,marginTop:6},
});
