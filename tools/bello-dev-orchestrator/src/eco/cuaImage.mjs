import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {localEnvironment} from '../pipeline/process.mjs';
const crc=bytes=>{let c=0xffffffff;for(const b of bytes){c^=b;for(let n=0;n<8;n++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
/** Validate real PNG bytes and compute the digest on the trusted host, never trust worker metadata. */
export function inspectCuaImage(root,ref){
 if(typeof ref!=='string'||!(/\.(?:png|jpe?g)$/i).test(ref)||path.isAbsolute(ref)||ref.split(/[\\/]/).some(v=>!v||v==='.'||v==='..'))throw Error('CUA requires a relative native PNG/JPEG screenshot');
 const base=fs.realpathSync(root);let current=base;for(const part of ref.split(/[\\/]/)){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw Error('Linked CUA evidence is forbidden');}
 const stat=fs.lstatSync(current);if(!stat.isFile()||stat.nlink!==1||stat.size<57||stat.size>5*1024*1024)throw Error('CUA screenshot size/type is invalid');
 const b=fs.readFileSync(current);if(/\.jpe?g$/i.test(ref))return inspectJpeg(current,ref,b);
 if(!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('CUA screenshot is not a PNG');
 let at=8,width,height,channels,end=false;const idat=[];
 while(at<b.length){if(at+12>b.length)throw Error('Truncated PNG');const size=b.readUInt32BE(at),type=b.toString('ascii',at+4,at+8);if(size>5*1024*1024||at+12+size>b.length||crc(b.subarray(at+4,at+8+size))!==b.readUInt32BE(at+8+size))throw Error('Invalid PNG chunk');
  if(type==='IHDR'){if(at!==8||size!==13)throw Error('Invalid PNG header');width=b.readUInt32BE(at+8);height=b.readUInt32BE(at+12);channels=({0:1,2:3,4:2,6:4})[b[at+17]];if(!width||!height||width>4096||height>4096||!channels||b[at+16]!==8||b[at+18]||b[at+19]||b[at+20])throw Error('Unsupported bounded PNG');}
  else if(type==='IDAT')idat.push(b.subarray(at+8,at+8+size));else if(type==='IEND'){if(size||at+12!==b.length)throw Error('Invalid PNG end');end=true;}
  at+=12+size;
 }
 if(!end||!idat.length||!channels)throw Error('Incomplete PNG');const expected=(width*channels+1)*height;if(expected>64*1024*1024)throw Error('PNG exceeds decoded budget');const pixels=inflateSync(Buffer.concat(idat),{maxOutputLength:expected});if(pixels.length!==expected)throw Error('PNG decoded size mismatch');for(let row=0;row<height;row++)if(pixels[row*(width*channels+1)]>4)throw Error('Invalid PNG filter');
 return {ref,sha256:crypto.createHash('sha256').update(b).digest('hex'),width,height,mimeType:'image/png'};
}
function inspectJpeg(filename,ref,b){
 if(b[0]!==255||b[1]!==216||b[b.length-2]!==255||b[b.length-1]!==217)throw Error('Invalid/truncated native JPEG');
 let at=2,width,height,scans=0,ended=false;const allowed=new Set([0xc0,0xc2,0xc4,0xdb,0xdd,0xda,0xfe]);
 while(at<b.length){if(b[at++]!==255)throw Error('Invalid JPEG marker');while(b[at]===255)at++;const marker=b[at++];if(marker===0xd9){if(at!==b.length)throw Error('JPEG trailing bytes');ended=true;break;}if(!allowed.has(marker)&&(marker<0xe0||marker>0xef)||at+2>b.length)throw Error('Unsupported JPEG marker');const length=b.readUInt16BE(at);if(length<2||at+length>b.length)throw Error('Invalid JPEG segment');
  if(marker===0xc0||marker===0xc2){if(width||length<11||b[at+2]!==8)throw Error('Invalid JPEG frame');height=b.readUInt16BE(at+3);width=b.readUInt16BE(at+5);const components=b[at+7];if(!width||!height||width>4096||height>4096||![1,3,4].includes(components)||length!==8+3*components)throw Error('JPEG dimension/components budget');}
  at+=length;
  if(marker===0xda){if(!width||length<6)throw Error('JPEG scan without frame');scans++;const start=at;while(at<b.length){if(b[at]!==255){at++;continue;}const next=b[at+1];if(next===0||next>=0xd0&&next<=0xd7){at+=2;continue;}break;}if(at===start)throw Error('Empty JPEG entropy');}
 }
 if(!ended||!scans||!width)throw Error('Incomplete JPEG');
 if(process.platform!=='win32')throw Error('Native JPEG decode requires the approved Windows imaging host');
 const script="$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Drawing;$stream=[System.IO.File]::OpenRead($env:BELLO_CUA_IMAGE_PATH);try{$image=[System.Drawing.Image]::FromStream($stream,$true,$true);try{$bitmap=[System.Drawing.Bitmap]::new($image);try{$pixel=$bitmap.GetPixel($bitmap.Width-1,$bitmap.Height-1);@{width=$bitmap.Width;height=$bitmap.Height;decoded=$true}|ConvertTo-Json -Compress}finally{$bitmap.Dispose()}}finally{$image.Dispose()}}finally{$stream.Dispose()}";
 const decoded=spawnSync('powershell.exe',['-NoProfile','-Command',script],{windowsHide:true,env:{...localEnvironment(),BELLO_CUA_IMAGE_PATH:filename},encoding:'utf8',timeout:5000,maxBuffer:4096});let proof;try{proof=JSON.parse(decoded.stdout.trim());}catch{}
 if(decoded.status!==0||proof?.decoded!==true||proof.width!==width||proof.height!==height)throw Error('Native JPEG decode validation failed');
 return {ref,sha256:crypto.createHash('sha256').update(b).digest('hex'),width,height,mimeType:'image/jpeg',decoded:true};
}
