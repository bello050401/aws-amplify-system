import React,{useEffect,useRef} from "react";
import type {WheelPickerProps} from "./WheelPicker";
export function WheelPicker({label,options,value,onChange}:WheelPickerProps) {
  const node=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(node.current)node.current.scrollTop=Math.max(0,options.findIndex(option=>option.value===value))*44;},[]);
  const choose=(index:number)=>{const bounded=Math.max(0,Math.min(options.length-1,index));onChange(options[bounded].value);node.current?.scrollTo({top:bounded*44,behavior:"smooth"});};
  return <div style={{flex:1,position:"relative",minWidth:0}}>
    <div aria-hidden style={{position:"absolute",top:88,left:0,right:0,height:44,background:"#e2e3e7",borderRadius:10}}/>
    <div ref={node} role="listbox" aria-label={label} tabIndex={0} aria-activedescendant={`${label}-${value}`}
      onKeyDown={event=>{const index=options.findIndex(option=>option.value===value);if(event.key==="ArrowDown")choose(index+1);else if(event.key==="ArrowUp")choose(index-1);else if(event.key==="Home")choose(0);else if(event.key==="End")choose(options.length-1);else return;event.preventDefault();}}
      onScroll={event=>onChange(options[Math.max(0,Math.min(options.length-1,Math.round(event.currentTarget.scrollTop/44)))].value)}
      style={{height:220,paddingBlock:88,boxSizing:"border-box",overflowY:"auto",scrollSnapType:"y mandatory",scrollbarWidth:"none",overscrollBehavior:"contain",position:"relative"}}>
      {options.map(option=><div id={`${label}-${option.value}`} key={option.value} role="option" aria-selected={value===option.value} onClick={()=>choose(options.indexOf(option))} style={{height:44,scrollSnapAlign:"center",display:"flex",justifyContent:"center",alignItems:"center",paddingInline:6,fontFamily:"-apple-system,sans-serif",fontSize:value===option.value?21:17,color:value===option.value?"#161a1e":"#959ba3",cursor:"pointer",whiteSpace:"nowrap",overflow:"hidden"}}>{option.label}</div>)}
    </div></div>;
}
