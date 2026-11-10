import React,{useEffect,useRef,useState} from 'react';
export function InventoryQueryInput({value,onChange,onSubmit}:{value:string;onChange:(v:string)=>void;onSubmit:()=>void}){
 const composing=useRef(false),[text,setText]=useState(value);
 useEffect(()=>{if(!composing.current)setText(value);},[value]);
 return <input aria-label="商品名を検索" placeholder="商品名" type="search" enterKeyHint="search" value={text}
   onCompositionStart={()=>{composing.current=true;}}
   onCompositionEnd={e=>{composing.current=false;onChange(e.currentTarget.value);}}
   onChange={e=>{setText(e.currentTarget.value);if(!composing.current)onChange(e.currentTarget.value);}}
   onKeyDown={e=>{if(e.key==='Enter'&&!composing.current&&!e.nativeEvent.isComposing&&e.keyCode!==229){e.preventDefault();onSubmit();}}}
   style={{flex:1,fontFamily:'inherit',fontSize:16,padding:'11px 0',minWidth:0,color:'#263936',border:0,outline:'none',background:'transparent'}}/>;
}
