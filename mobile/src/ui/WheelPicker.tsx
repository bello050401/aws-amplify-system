import React, {useEffect,useRef} from "react";
import {ScrollView,Pressable,Text,View} from "react-native";
export interface WheelPickerProps {label:string; options:{value:string;label:string}[];value:string;onChange:(value:string)=>void}
export function WheelPicker({label,options,value,onChange}:WheelPickerProps) {
  const scroll=useRef<React.ComponentRef<typeof ScrollView>>(null);
  useEffect(()=>{scroll.current?.scrollTo({y:Math.max(0,options.findIndex(option=>option.value===value))*44,animated:false});},[]);
  return <View style={{flex:1,height:220}}><View pointerEvents="none" style={{position:"absolute",top:88,left:0,right:0,height:44,backgroundColor:"#e2e3e7",borderRadius:10}}/>
    <ScrollView ref={scroll} accessibilityLabel={label} snapToInterval={44} decelerationRate="fast" showsVerticalScrollIndicator={false} contentContainerStyle={{paddingVertical:88}}
      scrollEventThrottle={16} onScroll={event=>onChange(options[Math.max(0,Math.min(options.length-1,Math.round(event.nativeEvent.contentOffset.y/44)))].value)}>
      {options.map((option,index)=><Pressable key={option.value} accessibilityRole="button" accessibilityState={{selected:option.value===value}} onPress={()=>{onChange(option.value);scroll.current?.scrollTo({y:index*44,animated:true});}} style={{height:44,alignItems:"center",justifyContent:"center"}}><Text numberOfLines={1} style={{fontSize:option.value===value?21:17,color:option.value===value?"#161a1e":"#959ba3"}}>{option.label}</Text></Pressable>)}
    </ScrollView></View>;
}
