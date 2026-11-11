import React,{useEffect,useMemo,useRef,useState} from 'react';
import {ActivityIndicator,PanResponder,Pressable,Text,View} from 'react-native';
import {Image} from 'expo-image';
import {PHOTO_IDENTITY,boundPhoto,photoSwipe,photoDismiss,zoomPhoto,type PhotoTransform} from '../domain/photoViewport';

/** Mounted only while the viewer is open; full-size images are not persisted on disk. */
type PhotoProps={uri:string;onPrevious?:()=>void;onNext?:()=>void;onDismiss?:()=>void;onRetry?:()=>void};
export function ZoomablePhoto(props:PhotoProps) {
  // A refreshed signed URL is a new request, even when the photo ID is unchanged.
  // Unmount the old request so its late error cannot hide the new image.
  return <PhotoSurface key={props.uri} {...props}/>;
}
function PhotoSurface({uri,onPrevious,onNext,onDismiss,onRetry}:PhotoProps) {
  const [transform,setTransform]=useState(PHOTO_IDENTITY),[size,setSize]=useState({width:1,height:1});
  const [dismissY,setDismissY]=useState(0);
  const [loading,setLoading]=useState(true),[failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0);
  const [imageSize,setImageSize]=useState({width:0,height:0});
  const viewport=useRef<React.ElementRef<typeof View>>(null),origin=useRef({x:0,y:0});
  useEffect(()=>{setTransform(PHOTO_IDENTITY);setDismissY(0);setLoading(true);setFailed(false);setImageSize({width:0,height:0});tap.current=0;},[uri]);
  const current=useRef(transform);current.current=transform;
  const start=useRef<PhotoTransform>(PHOTO_IDENTITY),distance=useRef(0),tap=useRef(0),pinched=useRef(false);
  const latest=useRef({size,imageSize,onPrevious,onNext,onDismiss});latest.current={size,imageSize,onPrevious,onNext,onDismiss};
  const pan=useMemo(()=>PanResponder.create({
    onStartShouldSetPanResponder:()=>true,onMoveShouldSetPanResponder:()=>true,
    onPanResponderGrant:e=>{start.current=current.current;setDismissY(0);pinched.current=e.nativeEvent.touches.length>1;distance.current=0;viewport.current?.measureInWindow((x,y)=>{origin.current={x,y};});},
    onPanResponderMove:(e,g)=>{
      const touches=e.nativeEvent.touches,{width,height}=latest.current.size,image=latest.current.imageSize;
      if(touches.length>=2){
        pinched.current=true;
        setDismissY(0);
        const a=touches[0],b=touches[1],d=Math.hypot(a.pageX-b.pageX,a.pageY-b.pageY);
        if(!distance.current){distance.current=d;start.current=current.current;return;}
        setTransform(zoomPhoto(start.current,start.current.scale*d/distance.current,{x:(a.pageX+b.pageX)/2-origin.current.x-width/2,y:(a.pageY+b.pageY)/2-origin.current.y-height/2},width,height,image.width,image.height));
      }else if(!pinched.current&&start.current.scale>1){
        setTransform(boundPhoto({...start.current,x:start.current.x+g.dx,y:start.current.y+g.dy},width,height,image.width,image.height));
      }else if(!pinched.current&&latest.current.onDismiss){
        setDismissY(g.dy>0&&g.dy>Math.abs(g.dx)*1.5?g.dy:0);
      }
    },
    onPanResponderRelease:(_e,g)=>{
      if(pinched.current){setDismissY(0);tap.current=0;return;}
      if(latest.current.onDismiss&&photoDismiss(start.current,g.dx,g.dy)){tap.current=0;latest.current.onDismiss();return;}
      setDismissY(0);
      const direction=photoSwipe(start.current,g.dx,g.dy);
      if(direction){tap.current=0;(direction==='next'?latest.current.onNext:latest.current.onPrevious)?.();return;}
      if(Math.hypot(g.dx,g.dy)>8){tap.current=0;return;}
      const now=Date.now();
      if(now-tap.current<300){setTransform(current.current.scale>1?PHOTO_IDENTITY:{scale:2.5,x:0,y:0});tap.current=0;}else tap.current=now;
    },
    onPanResponderTerminate:()=>{setDismissY(0);tap.current=0;},
    onPanResponderTerminationRequest:()=>false,
  }),[]);
  return <View ref={viewport} style={{flex:1,overflow:'hidden'}} onLayout={e=>{setSize(e.nativeEvent.layout);setTransform(PHOTO_IDENTITY);viewport.current?.measureInWindow((x,y)=>{origin.current={x,y};});}}>
    {!failed&&<View {...pan.panHandlers} style={{flex:1,touchAction:'none',userSelect:'none'} as any} accessibilityLabel="写真。指で拡大・移動、ダブルタップで拡大と復帰">
      <Image key={attempt} source={{uri}} contentFit="contain" cachePolicy="none" loading="eager" pointerEvents="none" style={{flex:1,transform:[{translateX:transform.x},{translateY:transform.y+dismissY},{scale:transform.scale}]}}
        onLoadStart={()=>setLoading(true)} onLoad={e=>{setImageSize({width:e.source.width,height:e.source.height});setLoading(false);setFailed(false);}} onError={()=>{setLoading(false);setFailed(true);}}/>
    </View>}
    {loading&&<ActivityIndicator pointerEvents="none" color="white" style={{position:'absolute',top:'45%',alignSelf:'center'}}/>}
    {failed&&<View style={{flex:1,alignItems:'center',justifyContent:'center',gap:20}}><Text style={{color:'white'}}>写真を読み込めませんでした。</Text><Pressable accessibilityRole="button" onPress={()=>{setFailed(false);setLoading(true);setAttempt(n=>n+1);onRetry?.();}} style={{padding:18}}><Text style={{color:'white'}}>もう一度読み込む</Text></Pressable></View>}
  </View>;
}
