import {spawn,spawnSync} from 'node:child_process';
export function ownedDescendants(rows,pid){const ids=new Set(Array.isArray(pid)?pid:[pid]);let changed=true;while(changed){changed=false;for(const row of rows)if(ids.has(row.parentPid)&&!ids.has(row.pid)){ids.add(row.pid);changed=true;}}return rows.filter(row=>ids.has(row.pid));}
function snapshot(){
 const command='Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress';
 const r=spawnSync('powershell.exe',['-NoProfile','-Command',command],{windowsHide:true,encoding:'utf8',timeout:2500,maxBuffer:1024*1024});if(r.status!==0)throw Error('Process ownership snapshot unavailable');
 const value=JSON.parse(r.stdout.trim());return (Array.isArray(value)?value:[value]).map(p=>({pid:p.ProcessId,parentPid:p.ParentProcessId,createdAt:p.CreationDate}));
}
/** Only the known root PID and its observed tree are targeted. Never use process names. */
export async function stopOwnedWindowsTree(pid,{snapshotImpl=snapshot,rootStillOwned=()=>true,killImpl=null}={}){
 let before=null;try{before=ownedDescendants(snapshotImpl(),pid);}catch{}
 const result={method:'taskkill /T /F + PID/birthstamp verification',pid,requestedAt:new Date().toISOString(),observedTree:before,killExitCode:null,remaining:null};
 let current;try{current=snapshotImpl().find(p=>p.pid===pid);}catch{}
 if(!rootStillOwned()||!current||current.createdAt!==before?.find(p=>p.pid===pid)?.createdAt){result.ownershipChanged=true;result.treeGone=false;return result;}
 if(killImpl)result.killExitCode=await killImpl(pid);
 else await new Promise(resolve=>{const killer=spawn('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});let done=false;const end=code=>{if(done)return;done=true;result.killExitCode=code;resolve();};killer.once('close',end);killer.once('error',()=>end(null));setTimeout(()=>end(null),3500).unref();});
 if(before){try{const after=snapshotImpl(),newTree=ownedDescendants(after,before.map(p=>p.pid));result.pidReused=before.some(p=>after.some(q=>q.pid===p.pid&&q.createdAt!==p.createdAt));result.remaining=[...new Map([...before.filter(p=>after.some(q=>q.pid===p.pid&&q.createdAt===p.createdAt)),...newTree].map(p=>[p.pid,p])).values()];}catch{}}
 result.treeGone=!!before?.some(p=>p.pid===pid)&&!result.pidReused&&Array.isArray(result.remaining)&&result.remaining.length===0;return result;
}
