import React,{useRef,useState} from "react";
import {Modal,Pressable,Text,View} from "react-native";
import {CameraView,useCameraPermissions} from "expo-camera";
export interface ScannerProps {onRead:(code:string)=>void;onClose:()=>void}
export function BarcodeScanner({onRead,onClose}:ScannerProps){
  const [permission,request]=useCameraPermissions();const seen=useRef(false);const [error,setError]=useState("");
  return <Modal onRequestClose={onClose}><View style={{flex:1,backgroundColor:"#111",paddingTop:60}}><Pressable accessibilityRole="button" onPress={onClose} style={{padding:20}}><Text style={{color:"white",fontSize:18}}>閉じる</Text></Pressable>
    {!permission?.granted?<View style={{padding:24,gap:20}}><Text style={{color:"white"}}>バーコード・QRコードを読み取るためカメラを使用します。</Text><Pressable accessibilityRole="button" onPress={()=>{void request();}}><Text style={{color:"#8ddfe6"}}>カメラを許可する</Text></Pressable></View>:
      <CameraView style={{flex:1}} facing="back" onMountError={()=>setError("カメラを開けませんでした。端末の設定を確認してください。")} barcodeScannerSettings={{barcodeTypes:["qr","ean13","ean8","code128","code39","upc_a","upc_e","itf14","pdf417","datamatrix"]}} onBarcodeScanned={({data})=>{if(!seen.current&&data){seen.current=true;onRead(data);}}}/>}
    <Text accessibilityRole={error?"alert":undefined} style={{color:"white",padding:24}}>{error||"枠内にQRコード・バーコードを写してください。"}</Text>
  </View></Modal>;
}
