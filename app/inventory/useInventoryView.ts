"use client";
import {useEffect,useState} from 'react';
import {defaultInventoryView,INVENTORY_VIEW_KEY,sanitizeInventoryView,type InventoryViewPreferences} from '@/lib/inventory/viewPreferences';
const eventName='bello:inventory-view-changed';
function read(){try{return sanitizeInventoryView(JSON.parse(localStorage.getItem(INVENTORY_VIEW_KEY)??'null'));}catch{return defaultInventoryView();}}
export function useInventoryView(){
  const [view,setView]=useState(defaultInventoryView),[ready,setReady]=useState(false),[error,setError]=useState('');
  useEffect(()=>{const update=()=>setView(read());update();setReady(true);const storage=(e:StorageEvent)=>{if(e.key===INVENTORY_VIEW_KEY||e.key===null)update();};window.addEventListener(eventName,update);window.addEventListener('storage',storage);return()=>{window.removeEventListener(eventName,update);window.removeEventListener('storage',storage);};},[]);
  function change(patch:Partial<InventoryViewPreferences>){const next=sanitizeInventoryView({...read(),...patch});try{localStorage.setItem(INVENTORY_VIEW_KEY,JSON.stringify(next));setView(next);setError('');window.dispatchEvent(new Event(eventName));}catch{setError('表示設定を保存できません。ブラウザの保存設定を確認してください。');}}
  return {view,change,ready,error};
}
