import React,{useRef,useState} from "react";
import {CameraView,useCameraPermissions} from "expo-camera";
import {ScannerLayout} from "./ScannerLayout";
export interface ScannerProps {onRead:(code:string)=>void;onClose:()=>void}
export function BarcodeScanner({onRead,onClose}:ScannerProps){
  const [permission,request]=useCameraPermissions();const seen=useRef(false);const [error,setError]=useState("");
  return <ScannerLayout onClose={onClose} error={error} permissionAction={!permission?.granted ? ()=>{void request();} : undefined}>
    {permission?.granted && <CameraView style={{flex:1}} facing="back" onMountError={()=>setError("カメラを開けませんでした。端末の設定を確認してください。")} barcodeScannerSettings={{barcodeTypes:["qr","ean13","ean8","code128","code39","upc_a","upc_e","itf14","pdf417","datamatrix"]}} onBarcodeScanned={({data})=>{if(!seen.current&&data){seen.current=true;onRead(data);}}}/>}
  </ScannerLayout>;
}
