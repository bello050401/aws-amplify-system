import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { fetchAuthSession } from 'aws-amplify/auth/server';
import { runWithUserPoolServerContext } from '../amplify/userPoolServer';
import { reportServerSystemError } from './server';
import { safeErrorClass, safeErrorDigest, errorComponent } from './client';

/** Next's route error callback can run after its cookies() scope has unwound. */
export const reportInstrumentedRequestError: import('next').Instrumentation.onRequestError = async (error, request, context) => {
  const path = request.path.split(/[?#]/, 1)[0];
  if (!(path === '/inventory' || path.startsWith('/inventory/') || path.startsWith('/api/mobile/') || path.startsWith('/api/inventory/') || path.startsWith('/api/procurement/')) ||
      ['/inventory/login','/api/mobile/config','/api/mobile/session','/api/inventory/health'].some(p=>path===p||path.startsWith(p+'/'))) return;
  const cookie = request.headers.cookie;
  if (typeof cookie !== 'string' || !cookie || cookie.length > 32768) return;
  let expired = false, timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<void>(resolve => {timer=setTimeout(()=>{expired=true;resolve();},1500);});
  const capture = async () => {
    // The adapter receives only its existing authentication cookie, never the
    // original URL/host/body. Nothing from these headers enters the error queue.
    const synthetic = new NextRequest('http://127.0.0.1/internal-system-errors', {headers:{cookie}});
    const authorized = await runWithUserPoolServerContext({
      nextServerContext:{request:synthetic,response:NextResponse.next()},
      operation: async contextSpec => {
        const session=await fetchAuthSession(contextSpec),payload=session.tokens?.accessToken.payload;
        const groups=payload?.['cognito:groups'];
        return !!(typeof payload?.sub==='string' && payload.sub && Array.isArray(groups) && groups.every(g=>typeof g==='string') && ['ADMIN','EDITOR','VIEWER'].some(role=>groups.includes(role)));
      },
    });
    if (!authorized || expired) return;
    await reportServerSystemError({code:'SERVER_REQUEST_FAILED',surface:'server',component:errorComponent(path),operation:context.routeType==='render'?'render':'request',errorClass:safeErrorClass(error),digest:safeErrorDigest(error)});
  };
  try {await Promise.race([capture().catch(()=>{}),deadline]);} finally {clearTimeout(timer!);}
};
