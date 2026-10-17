import React,{useEffect,useRef,useState} from "react";
import {BrowserMultiFormatReader, type IScannerControls} from "@zxing/browser";
import type {ScannerProps} from "./BarcodeScanner";
import {ScannerLayout} from "./ScannerLayout";
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
  return <ScannerLayout error={error} onClose={onClose}>
    <video ref={video} muted playsInline autoPlay aria-label="バーコード読み取りカメラ" style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover"}}/>
  </ScannerLayout>;
}
