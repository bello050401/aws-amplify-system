import React,{useEffect,useRef,useState} from "react";
import {Modal,Pressable,Text,View} from "react-native";
import {BrowserMultiFormatReader, type IScannerControls} from "@zxing/browser";
import type {ScannerProps} from "./BarcodeScanner";
export function BarcodeScanner({onRead,onClose}:ScannerProps){
  const video=useRef<HTMLVideoElement>(null);const callback=useRef(onRead);callback.current=onRead;
  const [error,setError]=useState("");
  useEffect(()=>{let active=true;let found=false;let controls:IScannerControls|undefined;
    const reader=new BrowserMultiFormatReader();
    if(!navigator.mediaDevices?.getUserMedia){setError("カメラを利用できません。SafariでHTTPSのアプリ画面を開いてください。");return;}
    void reader.decodeFromConstraints({video:{facingMode:{ideal:"environment"}},audio:false},video.current!,result=>{
      if(active&&!found&&result){found=true;controls?.stop();callback.current(result.getText());}
    }).then(value=>{controls=value;if(!active||found)value.stop();}).catch(()=>{if(active)setError("カメラを開けませんでした。カメラの利用許可を確認して、もう一度開いてください。");});
    return()=>{active=false;controls?.stop();};
  },[]);
  return <Modal onRequestClose={onClose}><View style={{flex:1,backgroundColor:"#111",paddingTop:25}}><Pressable accessibilityRole="button" onPress={onClose} style={{padding:20}}><Text style={{color:"white",fontSize:18}}>閉じる</Text></Pressable>
    <video ref={video} muted playsInline autoPlay aria-label="バーコード読み取りカメラ" style={{width:"100%",flex:1,minHeight:0,objectFit:"cover"}}/>
    <Text accessibilityRole={error?"alert":undefined} style={{color:"white",padding:24,fontSize:16}}>{error||"QRコード・バーコードを中央に写してください。"}</Text>
  </View></Modal>;
}
