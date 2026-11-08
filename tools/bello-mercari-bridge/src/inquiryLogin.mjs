import {resolve} from 'node:path';
import {loadInquiryConfig} from './inquiryConfig.mjs';
import {openBelloAdminContext} from './belloSession.mjs';
import {openDedicatedLogin} from './session.mjs';

// Interactive first-time setup only. Passwords and cookies are never exported.
const opened=[],closed=[];let stopping=false;
const onOpened=context=>{
  opened.push(context);closed.push(new Promise(resolve=>context.once('close',resolve)));
  if(stopping)void context.close().catch(()=>{});
};
const closeAll=async()=>{stopping=true;await Promise.allSettled(opened.map(c=>c.close()));};
process.once('SIGINT',()=>{void closeAll();});
process.once('SIGTERM',()=>{void closeAll();});
try {
  const c=await loadInquiryConfig(process.argv[2]);
  process.stdout.write('Opening the dedicated BELLO and Mercari Shops login windows...\n');
  const results=await Promise.allSettled([
    openBelloAdminContext({origin:c.origin,profileDir:resolve(c.belloProfileDir),playwrightModulePath:resolve(c.playwrightModulePath),navigateToLogin:true,onOpened}),
    openDedicatedLogin({profileDir:resolve(c.profileDir),playwrightModulePath:resolve(c.playwrightModulePath),onOpened}),
  ]);
  if(results.some(r=>r.status==='rejected'))throw Error('WINDOW_OPEN_FAILED');
  process.stdout.write('Complete normal sign-in in both dedicated windows, then close both windows.\n');
  await Promise.all(closed);
}catch{await closeAll();process.stderr.write('Setup could not open the dedicated browsers. Check the configuration.\n');process.exitCode=1;}
