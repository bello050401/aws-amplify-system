import React,{useMemo,useState} from 'react';
import {Modal,Pressable,ScrollView,StyleSheet,Text,TextInput,View} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import {normalizeNameSearch} from '../../../lib/inventory/nameSearch';
import {colors} from './theme';

/** Selection is a draft until applied. Closing never changes its caller. */
export function MultiChoiceSheet({title,options,value,onApply,onClose,applyLabel='選択を適用',hint}:{
 title:string;options:{value:string;label:string}[];value:string[];
 onApply:(value:string[])=>void;onClose:()=>void;applyLabel?:string;hint?:string;
}){
 const [draft,setDraft]=useState(()=>[...new Set(value)]);
 const [query,setQuery]=useState('');
 const choices=useMemo(()=>[...options,...value.filter(v=>!options.some(o=>o.value===v)).map(v=>({value:v,label:v}))],[options,value]);
 const visible=choices.filter(o=>normalizeNameSearch(o.label).includes(normalizeNameSearch(query)));
 const toggle=(value:string)=>setDraft(current=>current.includes(value)?current.filter(v=>v!==value):[...current,value]);
 return <Modal transparent animationType="slide" onRequestClose={onClose}>
  <View style={s.shade}><View style={s.sheet} accessibilityViewIsModal>
   <View style={s.heading}><Text style={s.title}>{title}</Text><Pressable accessibilityRole="button" accessibilityLabel={title+'を閉じる'} onPress={onClose} style={s.close}><Ionicons name="close" size={24}/></Pressable></View>
   {hint&&<Text style={s.hint}>{hint}</Text>}
   <TextInput accessibilityLabel={title+'の候補を検索'} placeholder="候補を検索" value={query} onChangeText={setQuery} style={s.input}/>
   <ScrollView style={{maxHeight:120,flexGrow:0,flexShrink:0}} contentContainerStyle={s.chips} keyboardShouldPersistTaps="handled">{draft.map(v=><Pressable key={v} accessibilityRole="button" accessibilityLabel={(choices.find(o=>o.value===v)?.label??v)+'の選択を解除'} onPress={()=>toggle(v)} style={s.chip}><Text style={s.chipText}>{choices.find(o=>o.value===v)?.label??v}</Text><Ionicons name="close" size={16} color={colors.blue}/></Pressable>)}</ScrollView>
   <ScrollView style={{flexShrink:1}} keyboardShouldPersistTaps="handled">
    {visible.map(o=><Pressable key={o.value} accessibilityRole="checkbox" accessibilityLabel={o.label} accessibilityState={{checked:draft.includes(o.value)}} aria-checked={draft.includes(o.value)} onPress={()=>toggle(o.value)} style={s.choice}><Ionicons name={draft.includes(o.value)?'checkbox':'square-outline'} size={23} color={draft.includes(o.value)?colors.blue:colors.muted}/><Text style={s.text}>{o.label}</Text></Pressable>)}
    {!visible.length&&<Text style={s.hint}>該当する候補はありません。</Text>}
   </ScrollView>
   <View style={s.summary}><Text style={s.hint}>{draft.length}件選択</Text><Pressable accessibilityRole="button" onPress={()=>setDraft([])} style={s.close}><Text style={s.blue}>すべて解除</Text></Pressable></View>
   <View style={s.actions}><Pressable accessibilityRole="button" onPress={onClose} style={s.cancel}><Text style={s.blue}>キャンセル</Text></Pressable><Pressable accessibilityRole="button" onPress={()=>onApply(draft)} style={s.apply}><Text style={s.white}>{applyLabel}</Text></Pressable></View>
  </View></View>
 </Modal>;
}
const s=StyleSheet.create({
 shade:{flex:1,backgroundColor:'#0006',justifyContent:'flex-end'},sheet:{maxHeight:'88%',backgroundColor:'white',borderTopLeftRadius:22,borderTopRightRadius:22,padding:18,paddingBottom:28},
 heading:{flexDirection:'row',alignItems:'center',justifyContent:'space-between'},title:{fontSize:20,fontWeight:'700',color:colors.text},close:{minWidth:44,minHeight:44,alignItems:'center',justifyContent:'center'},hint:{fontSize:13,color:colors.muted,lineHeight:20},
 input:{borderWidth:1,borderColor:'#BBB',borderRadius:10,padding:12,fontSize:16,marginVertical:10,color:colors.text},
 chips:{flexDirection:'row',flexWrap:'wrap',gap:6,marginBottom:8},chip:{flexDirection:'row',gap:6,alignItems:'center',borderRadius:8,backgroundColor:'#EFF4FD',padding:9},chipText:{fontSize:13,color:colors.blue},
 choice:{flexDirection:'row',gap:12,alignItems:'center',minHeight:48,borderBottomWidth:1,borderColor:colors.border,paddingVertical:10},text:{fontSize:16,color:colors.text,flex:1},
 summary:{flexDirection:'row',alignItems:'center',justifyContent:'space-between'},actions:{flexDirection:'row',gap:10,borderTopWidth:1,borderColor:colors.border,paddingTop:10},cancel:{minHeight:48,paddingHorizontal:14,justifyContent:'center'},apply:{flex:1,minHeight:48,borderRadius:10,backgroundColor:colors.blue,alignItems:'center',justifyContent:'center'},blue:{fontSize:15,color:colors.blue},white:{fontSize:16,fontWeight:'600',color:'white'}
});
