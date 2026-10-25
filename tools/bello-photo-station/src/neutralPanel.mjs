// Enclosed, light flat furniture can have the same brightness as its wall.
// Locate a bounded smooth panel by its edges, then require separate vertical
// supports underneath. A wall patch alone is not evidence of a whole object.
function edgeMask(luma,w,h){
 const smooth=new Float32Array(w*h),mag=new Float32Array(w*h),dir=new Uint8Array(w*h),weights=[1,2,1];
 for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
  let sum=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)sum+=luma[(y+dy)*w+x+dx]*weights[dy+1]*weights[dx+1];smooth[y*w+x]=sum/16;
 }
 for(let y=2;y<h-2;y++)for(let x=2;x<w-2;x++){
  const i=y*w+x,gx=-smooth[i-w-1]+smooth[i-w+1]-2*smooth[i-1]+2*smooth[i+1]-smooth[i+w-1]+smooth[i+w+1],
   gy=-smooth[i-w-1]-2*smooth[i-w]-smooth[i-w+1]+smooth[i+w-1]+2*smooth[i+w]+smooth[i+w+1];
  mag[i]=Math.abs(gx)+Math.abs(gy);
  const angle=(Math.atan2(gy,gx)*180/Math.PI+180)%180;
  dir[i]=angle<22.5||angle>=157.5?0:angle<67.5?1:angle<112.5?2:3;
 }
 const thin=new Float32Array(w*h),edge=new Uint8Array(w*h),queue=[];
 for(let y=2;y<h-2;y++)for(let x=2;x<w-2;x++){
  const i=y*w+x,d=[1,w+1,w,w-1][dir[i]];
  if(mag[i]>=mag[i-d]&&mag[i]>=mag[i+d]&&mag[i]>=12){thin[i]=mag[i];if(mag[i]>=30){edge[i]=1;queue.push(i);}}
 }
 for(let k=0;k<queue.length;k++){const i=queue[k];for(const d of [-w-1,-w,-w+1,-1,1,w-1,w,w+1]){const n=i+d;if(n>=0&&n<edge.length&&!edge[n]&&thin[n]>=12){edge[n]=1;queue.push(n);}}}
 const blocked=new Uint8Array(w*h);
 for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++)if(edge[y*w+x])for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)blocked[(y+dy)*w+x+dx]=1;
 return blocked;
}

export function neutralPanelSubject({luma,width:w,height:h,band,bandY,components}){
 const edge=edgeMask(luma,w,h),regions=components(Uint8Array.from(edge,v=>v?0:1),w,h),total=w*h;
 const candidates=regions.filter(p=>{
  const bw=p.right-p.left+1,bh=p.bottom-p.top+1;
  if(p.left<=band||p.right>=w-band-1||p.top<=bandY||p.bottom>=h-bandY-1||p.size<total*.015
   ||bw<w*.20||bw>w*.55||bh>h*.30||bw<bh*1.8||p.size/(bw*bh)<.2)return false;
  const mean=p.pixels.reduce((s,i)=>s+luma[i],0)/p.size;
  const deviation=Math.sqrt(p.pixels.reduce((s,i)=>s+(luma[i]-mean)**2,0)/p.size);
  return mean>150&&deviation<15;
 });
 const found=[];
 for(const panel of candidates){
  const bottoms=new Int16Array(w).fill(-1);for(const i of panel.pixels)bottoms[i%w]=Math.max(bottoms[i%w],Math.floor(i/w));
  const spans=[.013,.021,.031].map(f=>Math.max(3,Math.round(w*f))),minRun=Math.ceil(h*.055),runs=[];
  for(let x=panel.left;x<=panel.right;x++){
   const bottom=Math.max(...Array.from({length:7},(_,k)=>bottoms[Math.max(0,Math.min(w-1,x+k-3))]));
   if(bottom<0)continue;
   let start=null;
   const end=Math.min(h-bandY-1,panel.bottom+Math.ceil(h*.26));
   for(let y=Math.max(panel.top,bottom-3);y<=end;y++){
    const v=luma[y*w+x],on=y<end&&spans.some(s=>x-s>=0&&x+s<w&&luma[y*w+x-s]-v>14&&luma[y*w+x+s]-v>14);
    if(on&&start===null)start=y;
    if(!on&&start!==null){if(y-start>=minRun&&start<=bottom+h*.065)runs.push({x,top:start,bottom:y-1});start=null;}
   }
  }
  const groups=[];
  for(const run of runs){let group=groups.at(-1);if(!group||run.x-group.right>3){group={left:run.x,right:run.x,top:run.top,bottom:run.bottom,count:0};groups.push(group);}group.right=run.x;group.top=Math.min(group.top,run.top);group.bottom=Math.max(group.bottom,run.bottom);group.count++;}
  const supports=groups.filter(g=>g.count>=2&&g.bottom-g.top>(g.right-g.left)*1.5);
  if(supports.length<2||supports.at(-1).left-supports[0].right<(panel.right-panel.left)*.25)continue;
  const pad=Math.ceil(Math.min(w,h)*.025),box={left:panel.left-pad,right:panel.right+pad,top:panel.top-pad,bottom:Math.max(...supports.map(g=>g.bottom))+pad};
  if(box.left<=band||box.right>=w-band-1||box.top<=bandY||box.bottom>=h-bandY-1||box.bottom-box.top>h*.72)continue;
  found.push({box,size:panel.size,subjectSource:'neutral-panel'});
 }
 // Ambiguous multi-object scenes remain available for manual framing.
 return found.length===1?found[0]:null;
}
