"use client";

import {useLayoutEffect, useRef} from "react";

export function InlineNameInput({value,disabled,onChange,className}:{
  value:string;disabled:boolean;onChange:(value:string)=>void;className:string;
}) {
  const ref=useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(()=>{
    const input=ref.current;
    if(!input)return;
    const resize=()=>{input.style.height="0px";input.style.height=Math.max(44,input.scrollHeight+2)+"px";};
    resize();
    let width=input.clientWidth;
    const observer=new ResizeObserver(()=>{
      if(input.clientWidth!==width){width=input.clientWidth;resize();}
    });
    observer.observe(input);
    return ()=>observer.disconnect();
  },[value]);
  return <textarea ref={ref} aria-label="物品名" rows={2} disabled={disabled} value={value}
    onChange={event=>onChange(event.target.value)} className={className+" block resize-none overflow-hidden whitespace-pre-wrap leading-6"}/>;
}
