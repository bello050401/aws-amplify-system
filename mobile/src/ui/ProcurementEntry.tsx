import React,{useRef,useState} from 'react';
import {Linking,Pressable,ScrollView,StyleSheet,Text,View} from 'react-native';
import {PROCUREMENT_PROVIDERS,staffProcurementPath,type ProcurementProvider} from '../../../lib/procurement/providers';
import {API_ORIGIN} from '../runtime/service';
export const procurementAvailable = true;
const openBrowser=(provider:ProcurementProvider)=>Linking.openURL(API_ORIGIN+staffProcurementPath(provider));
export function ProcurementEntry({onClose,offline,preview,openSource=openBrowser}:{onClose:()=>void;offline:boolean;preview?:boolean;openSource?:(provider:ProcurementProvider)=>Promise<unknown>}) {
  const [opening,setOpening]=useState<ProcurementProvider|null>(null);
  const [error,setError]=useState('');
  const busy=useRef(false);
  const open=async(provider:ProcurementProvider)=>{
    if(offline||preview||busy.current)return;
    busy.current=true;setOpening(provider);setError('');
    try{await openSource(provider);}catch{setError('仕入れ画面を開けませんでした。通信を確認して、もう一度お試しください。');}
    finally{busy.current=false;setOpening(null);}
  };
  return <ScrollView style={s.screen} contentContainerStyle={s.content}>
    <Pressable accessibilityRole="button" onPress={onClose} style={s.back}><Text style={s.backText}>← ホームに戻る</Text></Pressable>
    <Text accessibilityRole="header" style={s.heading}>仕入れ取込</Text>
    <Text style={s.note}>仕入れ先を選ぶと、BELLOの仕入れ画面をブラウザで開きます。初回はブラウザでもログインしてください。</Text>
    <Text style={s.note}>取り込み後はアプリに戻ってください。</Text>
    {offline&&<Text accessibilityRole="alert" style={s.note}>圏外です。通信を回復してから開いてください。</Text>}
    {preview&&<Text style={s.note}>操作確認用です。仕入れ先の取得・登録は実行しません。</Text>}
    {!!error&&<Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    <View style={s.choices}>{PROCUREMENT_PROVIDERS.map(provider=><Pressable key={provider.key} accessibilityRole="button" accessibilityLabel={provider.mobileLabel} disabled={offline||preview||!!opening} onPress={()=>open(provider.key)} style={[s.source,(offline||preview||!!opening)&&s.disabled]}><Text style={s.sourceText}>{provider.mobileLabel}{opening===provider.key?'（開いています…）':''}</Text></Pressable>)}</View>
  </ScrollView>;
}
const s=StyleSheet.create({screen:{flex:1,backgroundColor:'#F8F6F1'},content:{padding:16,width:'100%',maxWidth:620,alignSelf:'center'},back:{minHeight:44,justifyContent:'center'},backText:{fontSize:15,color:'#36746A'},heading:{fontSize:24,fontWeight:'700',color:'#263D3C',marginTop:16,marginBottom:8},note:{fontSize:14,lineHeight:24,color:'#526B63',marginTop:8},error:{color:'#B42318',fontSize:14,lineHeight:24,marginTop:12},choices:{gap:12,marginTop:24},source:{minHeight:64,padding:18,borderWidth:1,borderColor:'#D5DFD7',borderRadius:16,backgroundColor:'white',justifyContent:'center'},sourceText:{fontSize:16,fontWeight:'600',lineHeight:24,color:'#263D3C'},disabled:{opacity:.5}});
