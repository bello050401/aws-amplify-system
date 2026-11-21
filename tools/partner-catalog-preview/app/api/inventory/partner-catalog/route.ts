import {NextResponse} from 'next/server';
import {state} from '../../../../fixture';
export const dynamic='force-dynamic';
export async function GET(){return NextResponse.json({ok:true,grants:state().grants});}
export async function POST(request:Request){
  const data=await request.json(),allowed=data.action==='create'?['action','label','title','expiresInDays']:data.action==='renew'?['action','id','expiresInDays']:['action','id'];
  if(!['create','renew','disable'].includes(data.action)||Object.keys(data).some(key=>!allowed.includes(key)))return NextResponse.json({ok:false},{status:400});
  const now=new Date().toISOString();
  if(data.label==='error')return NextResponse.json({ok:false},{status:503});
  if(data.action==='create'){
    const grant={id:crypto.randomUUID(),label:data.label,title:data.title,createdAt:now,updatedAt:now,expiresAt:new Date(Date.now()+90*86400000).toISOString(),disabled:false,path:'/share/inventory/demo',revision:1,selectedIds:[]};
    state().grants=[grant,...state().grants];return NextResponse.json({ok:true,grant},{status:201});
  }
  const index=state().grants.findIndex(g=>g.id===data.id);if(index<0)return NextResponse.json({ok:false},{status:404});
  state().grants[index]={...state().grants[index],revision:state().grants[index].revision+1,updatedAt:now,disabled:data.action==='disable',...(data.action==='renew'?{expiresAt:new Date(Date.now()+90*86400000).toISOString(),path:'/share/inventory/demo?renewed=1'}:{})};
  return NextResponse.json({ok:true,grant:state().grants[index]});
}
