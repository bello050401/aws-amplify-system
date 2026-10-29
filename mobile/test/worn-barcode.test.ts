import test from 'node:test';
import assert from 'node:assert/strict';
import {RGBLuminanceSource} from '@zxing/library';
import {decodeWornEanLabel} from '../src/runtime/wornBarcode';

// Independent EAN-13 fixture encoder (including an intentionally bad check digit).
const left=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const parity=['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
const invert=(s:string)=>s.replace(/[01]/g,c=>c==='0'?'1':'0');
function fixture(code:string,{reverse=false,holes=false,oneRow=false}={}){
 let bits='000000000000101';
 for(let i=1;i<7;i++){const p=left[Number(code[i])];bits+=parity[Number(code[0])][i-1]==='L'?p:invert(p).split('').reverse().join('');}
 bits+='01010';for(let i=7;i<13;i++)bits+=invert(left[Number(code[i])]);bits+='101000000000000';if(reverse)bits=bits.split('').reverse().join('');
 const scale=4,width=bits.length*scale,height=240,data=new Uint8ClampedArray(width*height).fill(220);
 for(let y=50;y<190;y++){if(oneRow&&y!==120)continue;for(let x=0;x<width;x++)if(bits[Math.floor(x/scale)]==='1')data[y*width+x]=holes&&((x*13+y*7)%53===0)?175:35;}
 return new RGBLuminanceSource(data,width,height);
}
test('fallback reads EAN-13 for several unrelated product numbers',()=>{
 for(const code of ['2026042311254','4901234567894','4006381333931'])assert.equal(decodeWornEanLabel(fixture(code)).getText(),code);
});
test('fallback tolerates speckled print and reversed labels',()=>{
 assert.equal(decodeWornEanLabel(fixture('2026042311254',{holes:true,reverse:true})).getText(),'2026042311254');
});
test('bad EAN check digit is rejected, never repaired into another product ID',()=>{
 assert.throws(()=>decodeWornEanLabel(fixture('2026042311255')));
});
test('a single matching scan row is insufficient',()=>{
 assert.throws(()=>decodeWornEanLabel(fixture('2026042311254',{oneRow:true})));
});
test('blank image and low contrast noise produce no barcode',()=>{
 const data=new Uint8ClampedArray(600*400).fill(160);assert.throws(()=>decodeWornEanLabel(new RGBLuminanceSource(data,600,400)));
 for(let i=0;i<data.length;i++)data[i]=150+(i*23%20);assert.throws(()=>decodeWornEanLabel(new RGBLuminanceSource(data,600,400)));
});
