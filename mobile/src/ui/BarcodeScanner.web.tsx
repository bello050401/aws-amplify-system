import React,{useEffect,useRef,useState} from "react";
import type {IScannerControls} from "@zxing/browser";
import {createInventoryBarcodeReader,focusBarcodeCamera} from '../runtime/barcodeReader';
import type {ScannerProps} from "./BarcodeScanner";
import {ScannerLayout} from "./ScannerLayout";
export function BarcodeScanner({onRead,onClose}:ScannerProps){
  const video=useRef<HTMLVideoElement>(null);const callback=useRef(onRead);callback.current=onRead;
  const [error,setError]=useState("");
  useEffect(()=>{let active=true;let found=false;let controls:IScannerControls|undefined;
    const reader=createInventoryBarcodeReader();
    if(!navigator.mediaDevices?.getUserMedia){setError("カメラを利用できません。SafariでHTTPSのアプリ画面を開いてください。");return;}
    void reader.decodeFromConstraints({video:{facingMode:{ideal:"environment"},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30,max:30}},audio:false},video.current!,result=>{
      if(active&&!found&&result){found=true;controls?.stop();callback.current(result.getText());}
    }).then(value=>{controls=value;if(!active||found){value.stop();return;}const stream=video.current?.srcObject;if(stream instanceof MediaStream){const track=stream.getVideoTracks()[0];if(track)void focusBarcodeCamera(track).catch(()=>undefined);}}).catch(()=>{if(active)setError("カメラを開けませんでした。カメラの利用許可を確認して、もう一度開いてください。");});
    return()=>{active=false;controls?.stop();};
  },[]);
  return <ScannerLayout error={error} onClose={onClose}>
    <video ref={video} muted playsInline autoPlay aria-label="バーコード読み取りカメラ" style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover"}}/>
  </ScannerLayout>;
}
