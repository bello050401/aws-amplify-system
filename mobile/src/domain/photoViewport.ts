export type PhotoTransform = {scale:number;x:number;y:number};
export const PHOTO_IDENTITY:PhotoTransform={scale:1,x:0,y:0};
export type PhotoBounds={width:number;height:number;imageWidth?:number;imageHeight?:number};
export function containedPhoto(width:number,height:number,imageWidth?:number,imageHeight?:number){
  if(!imageWidth||!imageHeight)return {width,height};
  const ratio=Math.min(width/imageWidth,height/imageHeight);
  return {width:imageWidth*ratio,height:imageHeight*ratio};
}
export function boundPhoto(t:PhotoTransform,width:number,height:number,imageWidth?:number,imageHeight?:number):PhotoTransform {
  const scale=Math.max(1,Math.min(5,t.scale));
  const image=containedPhoto(width,height,imageWidth,imageHeight);
  const bound=(n:number,viewport:number,size:number)=>{const limit=Math.max(0,(size*scale-viewport)/2);return Math.max(-limit,Math.min(limit,n));};
  return {scale,x:bound(t.x,width,image.width),y:bound(t.y,height,image.height)};
}
/** Scale about the fingers, not about a changing arbitrary image origin. */
export function zoomPhoto(t:PhotoTransform,scale:number,anchor:{x:number;y:number},width:number,height:number,imageWidth?:number,imageHeight?:number):PhotoTransform {
  const next=Math.max(1,Math.min(5,scale)),ratio=next/t.scale;
  return boundPhoto({scale:next,x:anchor.x-(anchor.x-t.x)*ratio,y:anchor.y-(anchor.y-t.y)*ratio},width,height,imageWidth,imageHeight);
}
export function photoSwipe(start:PhotoTransform,dx:number,dy:number):'previous'|'next'|null {
  return start.scale<=1.01&&Math.abs(dx)>70&&Math.abs(dx)>Math.abs(dy)*1.5?(dx<0?'next':'previous'):null;
}
/** Downward dismissal is distinct from paging and never applies while zoomed. */
export function photoDismiss(start:PhotoTransform,dx:number,dy:number):boolean {
  return start.scale<=1.01&&dy>80&&dy>Math.abs(dx)*1.5;
}
