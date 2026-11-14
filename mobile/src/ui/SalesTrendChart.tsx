import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Line, Path, Text as SvgText } from "react-native-svg";
import type { SalesTrendPoint } from "../../../lib/inventory/salesViewTypes";
import { salesChart } from "../../../lib/inventory/salesChart";

const yen = (value: number) => `¥${Math.round(value).toLocaleString("ja-JP")}`;
export function SalesTrendChart({ points }: { points: SalesTrendPoint[] }) {
  const [width, setWidth] = useState(326);
  const [active, setActive] = useState<number | null>(null);
  const height = 180;
  const chart = salesChart(points, width, height);
  const selected = active === null ? null : points[active];
  const pointLabel = (point: SalesTrendPoint) => `${point.year}年${point.month}月：${point.status === "ok" ? `売上高 ${yen(point.totalSales)}、粗利益 ${yen(point.totalGrossProfit)}` : point.status === "missing" ? "未集計" : "取得エラー"}`;
  return <View onLayout={event => setWidth(Math.max(200, event.nativeEvent.layout.width))}>
    <View style={s.legend}><View style={s.key}><View style={[s.line,{backgroundColor:"#111827"}]}/><Text style={s.label}>売上高</Text></View><View style={s.key}><View style={[s.line,{backgroundColor:"#10b981"}]}/><Text style={s.label}>粗利益</Text></View></View>
    <View style={{height}}>
      <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} accessibilityLabel="直近12ヶ月の売上高・粗利益の折れ線グラフ">
        <Line x1={chart.padding.left} x2={width-chart.padding.right} y1={chart.yFor(0)} y2={chart.yFor(0)} stroke="#e5e7eb"/>
        <Path d={chart.salesPath} fill="none" stroke="#111827" strokeWidth={2}/>
        <Path d={chart.profitPath} fill="none" stroke="#10b981" strokeWidth={2}/>
        {points.map((point,index)=><React.Fragment key={`${point.year}-${point.month}`}>
          <SvgText x={chart.xFor(index)} y={height-5} textAnchor="middle" fill="#6b7280" fontSize={11}>{point.month === 1 ? `${String(point.year).slice(-2)}/1` : String(point.month)}</SvgText>
          {point.status === "ok" ? <><Circle cx={chart.xFor(index)} cy={chart.yFor(point.totalSales)} r={3} fill="#111827"/><Circle cx={chart.xFor(index)} cy={chart.yFor(point.totalGrossProfit)} r={3} fill="#10b981"/></> : <Circle cx={chart.xFor(index)} cy={chart.yFor(0)} r={3} fill="white" stroke={point.status === "error" ? "#dc2626" : "#9ca3af"} strokeWidth={1.5}/>}
        </React.Fragment>)}
        {active !== null && <Line x1={chart.xFor(active)} x2={chart.xFor(active)} y1={chart.padding.top} y2={height-chart.padding.bottom} stroke="#9ca3af" strokeDasharray="3 3"/>}
      </Svg>
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {points.map((point,index)=>{
          const left = index === 0 ? 0 : (chart.xFor(index-1)+chart.xFor(index))/2;
          const right = index === points.length-1 ? width : (chart.xFor(index)+chart.xFor(index+1))/2;
          return <Pressable key={`${point.year}-${point.month}`} accessibilityRole="button" accessibilityLabel={pointLabel(point)} onPress={()=>setActive(index)} onHoverIn={()=>setActive(index)} onFocus={()=>setActive(index)} style={{position:"absolute",left,width:right-left,top:0,bottom:0}}/>;
        })}
      </View>
    </View>
    <Text style={s.readout} accessibilityLiveRegion="polite">{selected ? pointLabel(selected) : "グラフの月をタップすると金額を表示します"}</Text>
  </View>;
}
const s=StyleSheet.create({legend:{flexDirection:"row",gap:20,marginBottom:8},key:{flexDirection:"row",alignItems:"center",gap:5},line:{width:16,height:2},label:{fontSize:12,color:"#4b5563"},readout:{fontSize:12,lineHeight:18,color:"#4b5563",minHeight:36,marginTop:6}});
