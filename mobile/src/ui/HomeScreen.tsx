import React from "react";
import {ActivityIndicator,Pressable,ScrollView,StyleSheet,Text,View} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import {Image} from "expo-image";
interface Props{offline:boolean;creating:boolean;writesEnabled:boolean;onInventory:()=>void;onCreate:()=>void;onScan:()=>void;onPriceEntry:()=>void;onMessages?:()=>void;}
export function HomeScreen({offline,creating,writesEnabled,onInventory,onCreate,onScan,onPriceEntry,onMessages}:Props){
 const actions:Array<{title:string;hint:string;icon:React.ComponentProps<typeof Ionicons>['name'];onPress:()=>void;disabled?:boolean;loading?:boolean}>=[
 ...(writesEnabled?[{title:'新規登録',hint:'商品を追加',icon:'add-circle-outline' as const,onPress:onCreate,disabled:creating,loading:creating}]:[]),
 {title:'スキャン検索',hint:'バーコードから探す',icon:'scan-outline',onPress:onScan},
 ...(writesEnabled?[{title:'販売予定価格入力',hint:'写真を見ながら価格設定',icon:'pricetag-outline' as const,onPress:onPriceEntry,disabled:offline}]:[]),
 ...(writesEnabled&&onMessages?[{title:'メッセージ',hint:'確認・返信案をコピー',icon:'chatbubbles-outline' as const,onPress:onMessages,disabled:offline}]:[])];
 return <ScrollView style={s.screen} contentContainerStyle={s.content}>
 <View style={s.identity}><Image source={require("../../assets/bello-system-icon.png")} style={s.logo} contentFit="contain" accessibilityLabel="Bello SYSTEM"/>
 <View style={{flex:1}}><Text style={s.heading}>商品・在庫管理</Text><View style={s.connection}><Ionicons name={offline?'cloud-offline-outline':'wifi-outline'} size={13} color="#36746A"/><Text style={s.connectionText}>{offline?'圏外・保存済み情報を表示':'オンライン'}</Text></View></View></View>
 <Pressable accessibilityRole="button" accessibilityLabel="在庫一覧を開く" onPress={onInventory} style={({pressed})=>[s.inventory,pressed&&s.pressed]}>
 <View style={s.inventoryIcon}><Ionicons name="cube-outline" size={27} color="#E9CA87"/></View><View style={{flex:1}}><Text style={s.inventoryTitle}>在庫一覧</Text><Text style={s.inventoryHint}>検索・絞り込み・並び替え</Text></View><Ionicons name="arrow-forward" size={22} color="#E6ECE9"/></Pressable>
 <Text style={s.sectionTitle}>クイック操作</Text><View style={s.actions}>{actions.map(action=><Pressable key={action.title} accessibilityRole="button" accessibilityLabel={action.title} disabled={action.disabled} onPress={action.onPress} style={({pressed})=>[s.action,pressed&&s.pressed,action.disabled&&{opacity:.5}]}>
 <View style={s.actionTop}><View style={s.actionIcon}>{action.loading?<ActivityIndicator color="#36746A"/>:<Ionicons name={action.icon} size={23} color="#36746A"/>}</View><Ionicons name="chevron-forward" size={17} color="#89978F"/></View><Text style={s.actionTitle}>{action.title}</Text><Text style={s.actionHint}>{action.hint}</Text></Pressable>)}</View></ScrollView>;
}
const s=StyleSheet.create({
 screen:{flex:1,backgroundColor:'#F8F6F1'},content:{padding:16,paddingTop:8,paddingBottom:24,width:'100%',maxWidth:620,alignSelf:'center'},
 identity:{flexDirection:'row',gap:12,alignItems:'center',marginBottom:18},logo:{width:48,height:48,borderRadius:12},heading:{fontSize:20,fontWeight:'700',color:'#26332F'},
 connection:{marginTop:6,gap:5,flexDirection:'row',alignItems:'center'},connectionText:{fontSize:11,color:'#36746A'},
 inventory:{flexDirection:'row',alignItems:'center',gap:14,backgroundColor:'#263D3C',borderRadius:20,padding:18,minHeight:96},inventoryIcon:{width:44,height:44,borderRadius:14,alignItems:'center',justifyContent:'center',backgroundColor:'#37504D'},
 inventoryTitle:{color:'white',fontSize:21,fontWeight:'700'},inventoryHint:{color:'#C1D2CC',fontSize:12,marginTop:6},
 sectionTitle:{fontSize:12,fontWeight:'600',color:'#7A7D71',marginTop:22,marginBottom:10},actions:{flexDirection:'row',flexWrap:'wrap',gap:12},action:{width:'47%',flexGrow:1,minWidth:130,backgroundColor:'white',borderWidth:1,borderColor:'#E2E6DE',borderRadius:18,padding:14,minHeight:126},
 actionTop:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginBottom:11},actionIcon:{width:36,height:36,borderRadius:11,alignItems:'center',justifyContent:'center',backgroundColor:'#EDF3EE'},
 actionTitle:{color:'#263D3C',fontSize:15,fontWeight:'700'},actionHint:{color:'#78837A',fontSize:11,marginTop:5,lineHeight:16},pressed:{opacity:.76}
});
