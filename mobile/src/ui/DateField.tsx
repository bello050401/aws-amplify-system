import React, {useState} from "react";
import {Modal,Platform,Pressable,Text,View} from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import {colors} from "./theme";
export interface DateFieldProps {label:string;value:string;disabled?:boolean;onChange:(value:string)=>void}
export function DateField({label,value,disabled,onChange}:DateFieldProps) {
  const [open,setOpen]=useState(false);const [date,setDate]=useState(new Date());
  const commit=(d:Date)=>onChange(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`);
  return <View><Pressable accessibilityRole="button" accessibilityLabel={label+"を選択"} disabled={disabled} onPress={()=>{const next=value?new Date(value.replaceAll("/","-")+"T12:00:00"):new Date();setDate(Number.isFinite(next.getTime())?next:new Date());setOpen(true);}} style={{padding:16,borderWidth:1,borderColor:colors.border,borderRadius:10}}><Text style={{fontSize:17}}>{value.replaceAll("-","/")||"日付を選択"}</Text></Pressable>
    {open&&Platform.OS==="android"&&<DateTimePicker value={date} mode="date" onChange={(event,next)=>{setOpen(false);if(event.type==="set"&&next)commit(next);}}/>}
    <Modal visible={open&&Platform.OS!=="android"} transparent animationType="slide" onRequestClose={()=>setOpen(false)}><View style={{flex:1,justifyContent:"flex-end",backgroundColor:"#0005"}}><View style={{backgroundColor:"white",padding:20,paddingBottom:40,borderRadius:24}}><Text style={{fontSize:20,fontWeight:"700"}}>{label}</Text>
      <DateTimePicker value={date} mode="date" display="spinner" locale="ja-JP" onChange={(_,next)=>{if(next)setDate(next);}}/>
      <View style={{flexDirection:"row",justifyContent:"space-between"}}>{[["キャンセル",()=>setOpen(false)],["クリア",()=>{onChange("");setOpen(false);}],["決定",()=>{commit(date);setOpen(false);}]].map(([text,action])=><Pressable key={String(text)} accessibilityRole="button" onPress={action as ()=>void} style={{padding:16}}><Text style={{fontSize:17,color:colors.blue}}>{String(text)}</Text></Pressable>)}</View>
    </View></View></Modal>
  </View>;
}
