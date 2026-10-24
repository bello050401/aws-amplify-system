import React,{useState} from "react";
import {Platform,Pressable,Text,View,ActivityIndicator} from "react-native";
import {Image} from "expo-image";
import * as ImagePicker from "expo-image-picker";
import {ImageManipulator,SaveFormat} from "expo-image-manipulator";
import * as Crypto from "expo-crypto";
import type {PendingPhoto} from "../domain/inventory";
import {colors} from "./theme";
export function PhotoPicker({photos,disabled,onAdd,onRemove,onBusy,fixedType}:{photos:PendingPhoto[];disabled:boolean;onAdd:(photos:PendingPhoto[])=>void;onRemove:(id:string)=>void;onBusy:(busy:boolean)=>void;fixedType?:"DAMAGE"}){
  const [chosenType,setType]=useState<"NORMAL"|"DAMAGE">("NORMAL");const type=fixedType??chosenType;const [busy,setBusy]=useState(false);const [error,setError]=useState("");
  const pick=async(camera:boolean)=>{
    if(busy||disabled)return;setBusy(true);onBusy(true);setError("");
    try {
      if(camera&&Platform.OS!=="web"&&!(await ImagePicker.requestCameraPermissionsAsync()).granted)throw new Error("写真の撮影にはカメラの利用許可が必要です。");
      const result=camera?await ImagePicker.launchCameraAsync({mediaTypes:["images"],cameraType:ImagePicker.CameraType.back,quality:1}):await ImagePicker.launchImageLibraryAsync({mediaTypes:["images"],allowsMultipleSelection:true,quality:1});
      if(result.canceled)return;
      for(const asset of result.assets){
        const context=ImageManipulator.manipulate(asset.uri);
        if(Math.max(asset.width,asset.height)>2000)context.resize(asset.width>=asset.height?{width:2000}:{height:2000});
        const image=await context.renderAsync();const converted=await image.saveAsync({format:SaveFormat.JPEG,compress:0.85});
        onAdd([{id:Crypto.randomUUID(),uri:converted.uri,type}]);
      }
    }catch(error){setError(error instanceof Error?error.message:"写真を読み込めませんでした。");}
    finally{setBusy(false);onBusy(false);}
  };
  return <View style={{gap:12,marginBottom:24}}>
    {!fixedType&&<View style={{flexDirection:"row",gap:8}}>{([['NORMAL','商品画像'],['DAMAGE','傷・状態']]as const).map(([value,label])=><Pressable accessibilityRole="button" accessibilityState={{selected:type===value}} key={value} disabled={disabled||busy} onPress={()=>setType(value)} style={{padding:12,borderRadius:10,backgroundColor:type===value?colors.selection:"#f5f5f5"}}><Text>{label}を追加</Text></Pressable>)}</View>}
    <View style={{flexDirection:"row",gap:10}}>{([true,false] as const).map(camera=><Pressable key={String(camera)} accessibilityRole="button" disabled={disabled||busy} onPress={()=>{void pick(camera);}} style={{flex:1,padding:16,borderWidth:1,borderColor:colors.blue,borderRadius:12}}><Text style={{color:colors.blue,textAlign:"center"}}>{camera?"写真を撮影":"写真から選択"}</Text></Pressable>)}</View>
    {busy?<ActivityIndicator accessibilityLabel="写真を読み込み中"/>:null}{error?<Text accessibilityRole="alert" style={{color:colors.danger}}>{error}</Text>:null}
    {photos.length>0&&<Text>追加予定 {photos.length}枚（完了で保存）</Text>}
    <View style={{flexDirection:"row",flexWrap:"wrap",gap:8}}>{photos.map((photo,index)=><View key={photo.id} style={{width:100}}><Image source={{uri:photo.uri}} style={{width:100,height:100,borderRadius:10}}/><Text>{photo.type==="NORMAL"?"商品画像":"傷・状態"}</Text><Pressable accessibilityRole="button" accessibilityLabel={`追加予定の写真${index+1}を取り消す`} disabled={disabled||busy} onPress={()=>onRemove(photo.id)} style={{padding:10}}><Text style={{color:colors.danger}}>取り消す</Text></Pressable></View>)}</View>
  </View>;
}
