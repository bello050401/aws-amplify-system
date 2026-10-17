import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DateFieldProps } from "./DateField";
import { dateParts, dateValue, daysInMonth, validDateParts } from "../domain/dateWheel";

const rowHeight = 44;
function Wheel({label,values,value,onChange}:{label:string;values:number[];value:number;onChange:(value:number)=>void}) {
  const node = useRef<HTMLDivElement>(null);
  const scrolling = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { if (node.current && !scrolling.current) node.current.scrollTop = Math.max(0, values.indexOf(value)) * rowHeight; }, [value, values.length]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const choose = (next:number) => { scrolling.current=false; onChange(next); node.current?.scrollTo({top:values.indexOf(next)*rowHeight,behavior:"smooth"}); };
  return <div ref={node} role="listbox" aria-label={label} aria-activedescendant={`${label}-${value}`} tabIndex={0}
    onKeyDown={event=>{let index=values.indexOf(value);if(event.key==="ArrowDown")index++;else if(event.key==="ArrowUp")index--;else if(event.key==="Home")index=0;else if(event.key==="End")index=values.length-1;else return;event.preventDefault();choose(values[Math.max(0,Math.min(values.length-1,index))]);}}
    onScroll={event=>{const top=event.currentTarget.scrollTop;scrolling.current=true;const next=values[Math.max(0,Math.min(values.length-1,Math.round(top/rowHeight)))];onChange(next);clearTimeout(timer.current);timer.current=setTimeout(()=>{scrolling.current=false;},140);}}
    style={{flex:1,height:220,overflowY:"auto",scrollSnapType:"y mandatory",paddingBlock:88,boxSizing:"border-box",scrollbarWidth:"none",overscrollBehavior:"contain",position:"relative",zIndex:1}}>
    {values.map(number=><div id={`${label}-${number}`} key={number} role="option" aria-selected={number===value} onClick={()=>choose(number)} style={{height:rowHeight,scrollSnapAlign:"center",display:"flex",alignItems:"center",justifyContent:"center",fontSize:number===value?25:21,fontWeight:number===value?600:400,color:number===value?"#161a1e":"#959ba3",cursor:"pointer",userSelect:"none"}}>{number}{label}</div>)}
  </div>;
}
export function DateField({label,value,disabled,onChange}:DateFieldProps) {
  const [open,setOpen]=useState(false);
  const [draft,setDraft]=useState(()=>dateParts(value));
  const button=useRef<HTMLButtonElement>(null);
  const dialog=useRef<HTMLDivElement>(null);
  const close=()=>{setOpen(false);button.current?.focus();};
  useEffect(()=>{if(open)dialog.current?.focus();},[open]);
  const years=Array.from({length:Math.max(2100,draft.year)-Math.min(1900,draft.year)+1},(_,index)=>Math.min(1900,draft.year)+index);
  const action:React.CSSProperties={border:0,background:"#e5e7eb",borderRadius:24,padding:"11px 12px",fontSize:17,color:"#374151",fontFamily:"inherit",cursor:"pointer",minHeight:44,whiteSpace:"nowrap"};
  return <>
    <button ref={button} type="button" aria-label={label+"を選択"} aria-haspopup="dialog" disabled={disabled} onClick={()=>{setDraft(dateParts(value));setOpen(true);}} style={{fontFamily:"inherit",fontSize:17,color:value?"#303633":"#929793",textAlign:"left",background:"white",border:"1px solid #AAAFAA",borderRadius:10,padding:16,minHeight:56,width:"100%",boxSizing:"border-box",cursor:"pointer"}}>{value.replaceAll("-","/")||"年月日を選択"}</button>
    {open&&createPortal(<div style={{position:"fixed",inset:0,zIndex:100000,background:"#0005",display:"flex",justifyContent:"center",alignItems:"flex-end"}} onClick={event=>{if(event.target===event.currentTarget)close();}}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label+"の年月日選択"} onKeyDown={event=>{
        if(event.key==="Escape"){event.preventDefault();close();}
        if(event.key==="Tab"){const nodes=dialog.current?.querySelectorAll<HTMLElement>('button,[role="listbox"]');if(!nodes?.length)return;const first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
      }} style={{width:"100%",maxWidth:500,background:"#f4f4f6",borderRadius:"24px 24px 0 0",padding:"18px 16px calc(20px + env(safe-area-inset-bottom))",boxSizing:"border-box",fontFamily:"-apple-system, sans-serif",outline:"none"}}>
        <div style={{fontSize:16,fontWeight:600,marginBottom:14}}>{label}</div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
          <button type="button" onClick={close} style={action}>キャンセル</button>
          <div style={{display:"flex",gap:8}}><button type="button" onClick={()=>{onChange("");close();}} style={action}>クリア</button><button type="button" onClick={()=>{onChange(dateValue(draft));close();}} style={{...action,background:"#3D70D7",color:"white"}}>決定</button></div>
        </div>
        <div style={{position:"relative",display:"flex",marginTop:14}}>
          <div aria-hidden style={{position:"absolute",left:0,right:0,top:88,height:44,borderRadius:10,background:"#e2e3e7"}}/>
          <Wheel label="年" values={years} value={draft.year} onChange={year=>setDraft(date=>validDateParts({...date,year}))}/>
          <Wheel label="月" values={Array.from({length:12},(_,i)=>i+1)} value={draft.month} onChange={month=>setDraft(date=>validDateParts({...date,month}))}/>
          <Wheel label="日" values={Array.from({length:daysInMonth(draft.year,draft.month)},(_,i)=>i+1)} value={draft.day} onChange={day=>setDraft(date=>validDateParts({...date,day}))}/>
        </div>
      </div>
    </div>,document.body)}
  </>;
}
