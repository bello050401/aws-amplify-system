import React,{useState} from "react";
import {Modal,Pressable,ScrollView,StyleSheet,Text,TextInput,View} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import {operatorsForType,operatorNeedsNoValue,operatorNeedsSecondValue,type AdvancedSearchCondition} from "../../../lib/inventory/advancedSearch";
import {searchValidation,type AdvancedSearchQuery,type SearchFieldDef,type InventorySort} from "../domain/search";
import {DateField} from "./DateField";
import {WheelPicker} from "./WheelPicker";
import {colors} from "./theme";

interface Choice {label:string;value:string;group?:string}
function Choices({title,options,onChoose,onClose}:{title:string;options:Choice[];onChoose:(value:string)=>void;onClose:()=>void}) {
  return <Modal transparent animationType="slide" onRequestClose={onClose}><View style={s.shade}><View style={s.sheet}>
    <View style={s.sheetHeader}><Text style={s.heading}>{title}</Text><Pressable accessibilityRole="button" accessibilityLabel="選択を閉じる" onPress={onClose} style={s.close}><Ionicons name="close" size={24}/></Pressable></View>
    <ScrollView>{options.map((option,index)=><View key={option.value}>{option.group && options[index-1]?.group!==option.group ? <Text style={s.group}>{option.group}</Text>:null}<Pressable accessibilityRole="button" onPress={()=>onChoose(option.value)} style={s.choice}><Text style={s.choiceText}>{option.label}</Text></Pressable></View>)}</ScrollView>
  </View></View></Modal>;
}
export function InventorySearchScreen({value,fields,onApply,onClose}:{value:AdvancedSearchQuery;fields:SearchFieldDef[];onApply:(query:AdvancedSearchQuery)=>void;onClose:()=>void}) {
  const [draft,setDraft]=useState<AdvancedSearchQuery>(()=>({...value,conditions:value.conditions.map(condition=>({...condition}))}));
  const [choice,setChoice]=useState<{title:string;options:Choice[];choose:(value:string)=>void}|null>(null);
  const error=searchValidation(draft,fields);
  const update=(id:string,change:Partial<AdvancedSearchCondition>)=>setDraft(query=>({...query,conditions:query.conditions.map(condition=>condition.id===id?{...condition,...change}:condition)}));
  const add=()=>setChoice({title:"検索する項目",options:fields.map(field=>({label:field.label,value:field.key,group:field.group})),choose:key=>{
    const field=fields.find(def=>def.key===key)!;
    setDraft(query=>({...query,conditions:[...query.conditions,{id:`condition-${Date.now()}-${query.conditions.length}`,field:key,operator:operatorsForType(field.valueType)[0].value,value:""}]}));setChoice(null);
  }});
  return <View style={s.screen}>
    <View style={s.header}><Pressable accessibilityRole="button" accessibilityLabel="検索条件から戻る" style={s.back} onPress={onClose}><Ionicons name="chevron-back" size={28}/></Pressable><Text style={s.title}>検索条件一覧</Text><View style={{width:44}}/></View>
    <View style={s.toolbar}>
      <Pressable accessibilityRole="button" accessibilityLabel="条件の組み合わせ" style={s.combinator} onPress={()=>setChoice({title:"条件の組み合わせ",options:[{value:"AND",label:"すべての条件に一致（AND）"},{value:"OR",label:"いずれかの条件に一致（OR）"}],choose:value=>{setDraft(query=>({...query,combinator:value as "AND"|"OR"}));setChoice(null);}})}><Text style={s.combinatorText}>{draft.combinator==="AND"?"すべての条件に一致":"いずれかの条件に一致"}</Text><Ionicons name="chevron-down" size={16} color={colors.muted}/></Pressable>
      <Pressable accessibilityRole="button" disabled={draft.conditions.length>=20} onPress={add} style={s.outline}><Text style={s.blue}>検索条件を追加</Text></Pressable>
    </View>
    <ScrollView contentContainerStyle={{paddingBottom:24}} keyboardShouldPersistTaps="handled">
      {draft.conditions.map(condition=>{
        const field=fields.find(def=>def.key===condition.field);if(!field)return null;
        const operators=operatorsForType(field.valueType);
        const input=(second=false)=>{
          const value=(second?condition.value2:condition.value)??"";
          const label=field.label+(second?"の終了値":"の検索値");
          const onChange=(value:string)=>update(condition.id,second?{value2:value}:{value});
          if(field.valueType==="date"||field.valueType==="datetime")return <DateField label={label} value={value} onChange={onChange}/>;
          if(field.options)return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={()=>setChoice({title:field.label,options:field.options!,choose:value=>{onChange(value);setChoice(null);}})} style={s.input}><Text style={{fontSize:17,color:value?colors.text:colors.muted}}>{field.options.find(option=>option.value===value)?.label||"選択してください"}</Text></Pressable>;
          return <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} placeholder={field.label} inputMode={field.valueType==="number"?"decimal":"text"} keyboardType={field.valueType==="number"?"decimal-pad":"default"} style={s.input}/>;
        };
        return <View key={condition.id} style={s.condition}>
          <View style={s.conditionHeader}><Text style={s.heading}>{field.label}</Text><Pressable accessibilityRole="button" accessibilityLabel={field.label+"の条件を削除"} onPress={()=>setDraft(query=>({...query,conditions:query.conditions.filter(row=>row.id!==condition.id)}))} style={s.close}><Ionicons name="close-circle" size={22} color="#A6AAA8"/></Pressable></View>
          <Pressable accessibilityRole="button" accessibilityLabel={field.label+"の比較方法"} style={s.operator} onPress={()=>setChoice({title:field.label+"の比較方法",options:operators,choose:value=>{update(condition.id,{operator:value as AdvancedSearchCondition["operator"]});setChoice(null);}})}><Text style={s.blue}>{operators.find(op=>op.value===condition.operator)?.label}</Text><Ionicons name="chevron-down" size={16} color={colors.blue}/></Pressable>
          {!operatorNeedsNoValue(condition.operator)&&<View style={{gap:10}}>{input()}{operatorNeedsSecondValue(condition.operator)&&<><Text style={{textAlign:"center",color:colors.muted}}>〜</Text>{input(true)}</>}</View>}
        </View>;
      })}
    </ScrollView>
    <View style={s.footer}>{error&&<Text style={s.hint}>{error}</Text>}<View style={s.actions}><Pressable accessibilityRole="button" onPress={()=>setDraft({combinator:"AND",conditions:[]})} style={s.reset}><Text style={s.blue}>リセット</Text></Pressable><Pressable accessibilityRole="button" disabled={!!error} onPress={()=>onApply(draft)} style={[s.submit,error&&{opacity:.45}]}><Text style={s.white}>検索</Text></Pressable></View></View>
    {choice&&<Choices title={choice.title} options={choice.options} onChoose={choice.choose} onClose={()=>setChoice(null)}/>}
  </View>;
}

export function InventorySortSheet({value,fields,onApply,onClose}:{value:InventorySort;fields:SearchFieldDef[];onApply:(sort:InventorySort)=>void;onClose:()=>void}) {
  const [draft,setDraft]=useState(value);
  const preferred=["createdAt","updatedAt","name","categoryId","quantity","locationId","barcode","plannedSalePrice"];
  const sorted=[...fields].sort((a,b)=>(preferred.includes(a.key)?preferred.indexOf(a.key):100)-(preferred.includes(b.key)?preferred.indexOf(b.key):100));
  return <Modal transparent animationType="slide" onRequestClose={onClose}><View style={s.shade}><View style={s.sortSheet}>
    <Text style={s.heading}>並び替え</Text><View style={s.sortActions}><Pressable accessibilityRole="button" onPress={onClose} style={s.reset}><Text style={s.blue}>キャンセル</Text></Pressable><Pressable accessibilityRole="button" onPress={()=>onApply(draft)} style={s.done}><Text style={s.white}>完了</Text></Pressable></View>
    <View style={{flexDirection:"row",gap:8}}><View style={{flex:2}}><WheelPicker label="並び替え項目" options={sorted.map(field=>({value:field.key,label:field.label}))} value={draft.field} onChange={field=>setDraft(sort=>({...sort,field}))}/></View><View style={{flex:1}}><WheelPicker label="並び替え方向" options={[{value:"asc",label:"昇順"},{value:"desc",label:"降順"}]} value={draft.direction} onChange={direction=>setDraft(sort=>({...sort,direction:direction as "asc"|"desc"}))}/></View></View>
  </View></View></Modal>;
}

const s=StyleSheet.create({
  screen:{flex:1,backgroundColor:"white"},header:{height:80,backgroundColor:colors.cream,flexDirection:"row",alignItems:"center",justifyContent:"space-between",paddingHorizontal:16},back:{width:44,height:44,borderRadius:22,backgroundColor:"#fffaf0",alignItems:"center",justifyContent:"center"},title:{fontSize:21,fontWeight:"700",color:colors.text},
  toolbar:{padding:16,flexDirection:"row",gap:10,alignItems:"center",flexWrap:"wrap",borderBottomWidth:1,borderColor:colors.border},combinator:{flexDirection:"row",alignItems:"center",gap:6,minHeight:44,flexGrow:1},combinatorText:{fontSize:15,color:colors.muted},outline:{paddingHorizontal:12,paddingVertical:12,borderWidth:1.5,borderColor:colors.blue,borderRadius:10},blue:{color:colors.blue,fontSize:16,fontWeight:"600"},
  condition:{padding:18,borderBottomWidth:1,borderColor:colors.border},conditionHeader:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",gap:8},heading:{fontSize:18,fontWeight:"600",color:colors.text,flexShrink:1},close:{padding:10},operator:{flexDirection:"row",alignItems:"center",gap:6,alignSelf:"flex-end",minHeight:40,marginBottom:8},input:{borderWidth:1,borderColor:"#AAAFAA",borderRadius:10,padding:15,minHeight:56,fontSize:17,color:colors.text},
  footer:{borderTopWidth:1,borderColor:colors.border,padding:16,paddingBottom:22},actions:{flexDirection:"row",gap:16,alignItems:"center"},reset:{minHeight:48,paddingHorizontal:16,justifyContent:"center"},submit:{flex:1,minHeight:52,borderRadius:10,backgroundColor:colors.blue,alignItems:"center",justifyContent:"center"},white:{fontSize:17,color:"white",fontWeight:"600"},hint:{fontSize:12,color:colors.muted,marginBottom:12},
  shade:{flex:1,backgroundColor:"#0005",justifyContent:"flex-end"},sheet:{maxHeight:"80%",backgroundColor:"white",borderTopLeftRadius:24,borderTopRightRadius:24,padding:20,paddingBottom:30},sheetHeader:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",paddingBottom:8},choice:{paddingVertical:18,borderBottomWidth:1,borderColor:colors.border},choiceText:{fontSize:17,color:colors.text},group:{fontSize:12,color:colors.muted,paddingTop:18},sortSheet:{backgroundColor:"#f4f4f6",padding:16,paddingBottom:28,borderTopLeftRadius:24,borderTopRightRadius:24},sortActions:{flexDirection:"row",justifyContent:"space-between",marginTop:12},done:{paddingHorizontal:24,minHeight:44,borderRadius:24,backgroundColor:colors.blue,justifyContent:"center"},
});
