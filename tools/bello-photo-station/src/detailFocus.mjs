import sharp from 'sharp';
import { readFile } from 'node:fs/promises';

const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];

// A close-up may legitimately extend beyond the top/bottom of the photo.
// That is not proof of the whole product's bounds. Use only paired horizontal
// outlines, stable across rows, to centre the visible detail. Never change zoom.
export async function analyzeDetailFocus(file) {
  // Do not leave a libvips file-backed operation on the leveled cache image:
  // Windows must be able to replace that JPEG on the next preview/save.
  const {data,info}=await sharp(await readFile(file)).rotate().resize({width:384,withoutEnlargement:true})
    .toColourspace('srgb').removeAlpha().raw().toBuffer({resolveWithObject:true});
  const {width,height,channels}=info;
  if(width<80||height<80||channels!==3)return null;
  const band=Math.max(3,Math.floor(width*.06));
  const at=(x,y,c)=>data[(y*width+x)*3+c];
  const centres=[],lefts=[],rights=[];
  for(let y=Math.floor(height*.12);y<height*.90;y+=2) {
    const edge=side=>[0,1,2].map(c=>median(Array.from({length:band},(_,i)=>at(side?width-1-i:i,y,c))));
    const left=edge(0),right=edge(1);
    // A coloured wall, an object crossing a side edge, or uneven side lighting
    // cannot provide two reliable background references.
    if(left.some((v,c)=>Math.abs(v-right[c])>75)
      ||Math.max(...left)-Math.min(...left)>35||Math.max(...right)-Math.min(...right)>35)continue;
    const hits=[];
    for(let x=band;x<width-band;x++) {
      const rgb=[at(x,y,0),at(x,y,1),at(x,y,2)];
      const l=rgb.reduce((a,b)=>a+b,0)/3;
      const lb=left.reduce((a,b)=>a+b,0)/3,rb=right.reduce((a,b)=>a+b,0)/3;
      const chroma=Math.max(...rgb)-Math.min(...rgb);
      const difference=rgb.reduce((s,v,c)=>s+Math.abs(v-(left[c]+right[c])/2),0)/3;
      if(l<Math.min(lb,rb)-45||(chroma>32&&difference>35))hits.push(x);
    }
    if(hits.length<width*.12)continue;
    const l=hits[Math.floor(hits.length*.015)],r=hits[Math.floor(hits.length*.985)];
    // Keep background visible on both sides; reject room-wide bands and
    // isolated tiny components instead of shifting toward them.
    if(l<=band+2||r>=width-band-3||r-l<width*.24||r-l>width*.78)continue;
    centres.push((l+r)/2/width);lefts.push(l/width);rights.push(r/width);
  }
  if(centres.length<height*.12)return null;
  const x=median(centres),spread=median(centres.map(v=>Math.abs(v-x)));
  if(x<.30||x>.70||spread>.025)return null;
  return {x,y:.5,source:'paired-detail-outline',spread,
    left:median(lefts),right:median(rights),rows:centres.length};
}
