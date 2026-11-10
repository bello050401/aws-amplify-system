"use client";
import {useEffect,useState} from "react";
type Density="normal"|"compact";
const key="bello-inventory-list-density",eventName="inventory-list-density";
export function useInventoryListDensity(){
  const [density,setDensity]=useState<Density>("normal");
  useEffect(()=>{
    const read=()=>{try{setDensity(localStorage.getItem(key)==="compact"?"compact":"normal");}catch{}};
    const local=(event:Event)=>setDensity((event as CustomEvent<Density>).detail);
    const storage=(event:StorageEvent)=>{if(event.key===key)read();};
    read();window.addEventListener(eventName,local);window.addEventListener("storage",storage);
    return()=>{window.removeEventListener(eventName,local);window.removeEventListener("storage",storage);};
  },[]);
  const change=(value:Density)=>{setDensity(value);try{localStorage.setItem(key,value);}catch{}window.dispatchEvent(new CustomEvent(eventName,{detail:value}));};
  return {density,setDensity:change};
}
