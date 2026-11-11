"use client";
import {useEffect,useState,useRef} from 'react';
import {preferenceSections,sanitizePreference,type PreferenceSection} from '@/lib/inventory/preferenceSections';
type Remote={revision:number;value:unknown}|null;
type Pending=Partial<Record<PreferenceSection,{revision?:number;value:unknown}>>;
const ownerKey='bello-inventory-preference-owner',pendingKey='bello-inventory-preference-pending';
/** Four bounded sections per account. Unsent changes survive navigation;
 * a competing device's revision must never be overwritten automatically. */
export function InventoryPreferenceSync(){
 const [error,setError]=useState('');
 const retry=useRef<()=>void>(()=>{});
 useEffect(()=>{
  let stopped=false,hydrating=false,loaded=false,saving=false,loading=false;
  let owner=localStorage.getItem(ownerKey),pending:Pending={};
  try{const saved=JSON.parse(localStorage.getItem(pendingKey)??'null');if(saved?.owner===owner)for(const s of Object.keys(preferenceSections) as PreferenceSection[]){const p=saved.sections?.[s];if(p&&(p.revision===undefined||(Number.isSafeInteger(p.revision)&&p.revision>=0)))pending[s]={revision:p.revision,value:sanitizePreference(s,p.value)};}}catch{/* malformed local data is not sent */}
  const versions:Partial<Record<PreferenceSection,number>>={};
  let timer:ReturnType<typeof setTimeout>|undefined;
  const persist=()=>{if(owner&&Object.keys(pending).length)localStorage.setItem(pendingKey,JSON.stringify({owner,sections:pending}));else localStorage.removeItem(pendingKey);};
  const read=(s:PreferenceSection)=>{const v=localStorage.getItem(preferenceSections[s].key);return v===null?undefined:s==='density'?v:JSON.parse(v);};
  const flush=async()=>{
   if(stopped||!loaded||saving||!Object.keys(pending).length)return;
   saving=true;let succeeded=false;
   try{
    for(const section of Object.keys(pending) as PreferenceSection[]){
     const attempt=pending[section]!;
     const response=await fetch('/api/inventory/preferences',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({section,value:attempt.value,revision:attempt.revision??versions[section]??0})});
     const data=await response.json();if(!response.ok)throw Error(data.error||'端末間の設定を保存できません。');
     versions[section]=data.revision;
     if(pending[section]===attempt)delete pending[section];
     else if(pending[section])pending[section]!.revision=data.revision;
     persist();
    }
    if(!stopped)setError('');succeeded=true;
   }catch(e){if(!stopped)setError((e as Error).message);}
   finally{saving=false;if(succeeded&&Object.keys(pending).length&&!stopped)timer=setTimeout(()=>void flush(),400);}
  };
  const events=Object.entries(preferenceSections).map(([s,config])=>{
   const section=s as PreferenceSection;
   const handler=()=>{if(hydrating)return;try{pending[section]={revision:pending[section]?.revision??versions[section],value:sanitizePreference(section,read(section))};persist();clearTimeout(timer);timer=setTimeout(()=>void flush(),400);}catch(e){setError((e as Error).message);}};
   window.addEventListener(config.event,handler);return {config,handler};
  });
  const load=async()=>{
   if(loading||stopped)return;loading=true;
   try{
    const response=await fetch('/api/inventory/preferences',{cache:'no-store'});if(!response.ok)throw Error('端末間の設定を読み込めません。再試行してください。');
    const data=await response.json() as {owner:string;sections:Record<PreferenceSection,Remote>};if(stopped)return;
    hydrating=true;
    if(owner&&owner!==data.owner){pending={};for(const {key,event} of Object.values(preferenceSections)){localStorage.removeItem(key);window.dispatchEvent(new Event(event));}}
    owner=data.owner;localStorage.setItem(ownerKey,owner);
    for(const section of Object.keys(preferenceSections) as PreferenceSection[]){
     const remote=data.sections[section],config=preferenceSections[section];versions[section]=remote?.revision??0;
     if(pending[section]){
      pending[section]!.revision??=versions[section];
      const value=pending[section]!.value;localStorage.setItem(config.key,section==='density'?String(value):JSON.stringify(value));window.dispatchEvent(new CustomEvent(config.event,{detail:value}));continue;
     }
     if(remote){const value=sanitizePreference(section,remote.value);localStorage.setItem(config.key,section==='density'?String(value):JSON.stringify(value));window.dispatchEvent(new CustomEvent(config.event,{detail:value}));}
     else if(read(section)!==undefined)pending[section]={revision:0,value:sanitizePreference(section,read(section))};
    }
    persist();loaded=true;hydrating=false;setError('');await flush();
   }catch(e){hydrating=false;if(!stopped)setError((e as Error).message);}
   finally{loading=false;}
  };
  retry.current=()=>void(loaded?flush():load());void load();
  return()=>{stopped=true;clearTimeout(timer);for(const {config,handler} of events)window.removeEventListener(config.event,handler);};
 },[]);
 return error?<div role="alert" className="fixed bottom-3 right-3 z-[100] max-w-sm rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{error}<p>この端末の設定は保持されています。</p><button className="mr-3 min-h-10 underline" onClick={()=>retry.current()}>再試行</button><button className="min-h-10 underline" onClick={()=>{if(confirm('この端末の未同期設定を破棄し、保存済みの設定を読み込みますか？')){localStorage.removeItem(pendingKey);location.reload();}}}>保存済み設定に戻す</button></div>:null;
}
