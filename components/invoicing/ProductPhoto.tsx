'use client';
import React,{useState} from 'react';

export function ProductPhoto({url,name}:{url:string|null;name:string}) {
 const [failed,setFailed]=useState<string|null>(null);
 return <span className="product-photo">{url&&failed!==url
  // eslint-disable-next-line @next/next/no-img-element -- Short-lived authenticated S3 thumbnail.
  ? <img src={url} alt={name+'の商品画像'} loading="lazy" decoding="async" onError={()=>setFailed(url)}/>
  : <span className="photo-placeholder">画像なし</span>}</span>;
}
