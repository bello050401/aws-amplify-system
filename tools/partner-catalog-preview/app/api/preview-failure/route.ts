import {NextResponse} from 'next/server';
import {state} from '../../../fixture';
export async function POST(request:Request){const input=await request.json();if(!['none','unavailable','conflict'].includes(input.failure))return NextResponse.json({ok:false},{status:400});state().nextFailure=input.failure;return NextResponse.json({ok:true});}
