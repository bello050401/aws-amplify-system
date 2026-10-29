import {BitArray,EAN13Reader,LuminanceSource,NotFoundException,Result} from '@zxing/library';

/** Extra pass for EAN labels whose ink has spread or has small white holes.
 * Uses real bar patterns and the standard EAN checksum, never printed-text OCR.
 * Two separate scan rows must agree before accepting the fallback result.
 */
export function decodeWornEanLabel(source:LuminanceSource):Result {
  const width=source.getWidth(),height=source.getHeight();
  const reader=new EAN13Reader(),bits=new BitArray(width),seen=new Map<string,number>();
  let row:Uint8ClampedArray=new Uint8ClampedArray(width);
  const smooth=new Uint8ClampedArray(width),hist=new Uint32Array(256);
  for(let i=0;i<48;i++) {
    const offset=Math.ceil(i/2)*(i%2?-1:1);
    const y=Math.min(height-1,Math.max(0,Math.round(height*(.5+offset/60))));
    row=source.getRow(y,row);hist.fill(0);
    for(let x=2;x<width-2;x++) {const value=width<1100?(row[x-1]+2*row[x]+row[x+1])/4:(row[x-2]+2*row[x-1]+3*row[x]+2*row[x+1]+row[x+2])/9;smooth[x]=value;hist[smooth[x]]++;}
    let low=0,high=255,count=0;
    for(let v=0;v<256;v++){count+=hist[v];if(count>width*.1){low=v;break;}}
    count=0;for(let v=255;v>=0;v--){count+=hist[v];if(count>width*.1){high=v;break;}}
    if(high-low<35)continue;
    for(const fraction of [.32,.42,.22,.52]) {
      bits.clear();const threshold=low+(high-low)*fraction;
      for(let x=2;x<width-2;x++)if(smooth[x]<threshold)bits.set(x);
      for(let reverse=0;reverse<2;reverse++) {
        if(reverse)bits.reverse();
        try{const result=reader.decodeRow(y,bits);const text=result.getText();const previous=seen.get(text);if(previous!==undefined&&previous!==y)return result;seen.set(text,y);}catch{/* another threshold/row */}
      }
    }
  }
  throw new NotFoundException();
}
