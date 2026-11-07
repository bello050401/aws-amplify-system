import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openBelloAdminContext} from './belloSession.mjs';
import {openDedicatedLogin} from './session.mjs';

// Interactive first-time setup only. Passwords and cookies are never exported.
try {
  const c=JSON.parse(await readFile(resolve(process.argv[2]),'utf8'));
  const bello=await openBelloAdminContext({origin:c.origin,profileDir:resolve(c.belloProfileDir),playwrightModulePath:resolve(c.playwrightModulePath),navigateToLogin:true});
  const shops=await openDedicatedLogin({profileDir:resolve(c.profileDir),playwrightModulePath:resolve(c.playwrightModulePath)});
  process.stdout.write('Complete normal sign-in in both dedicated windows, then close both windows.\n');
  await Promise.all([new Promise(r=>bello.on('close',r)),new Promise(r=>shops.on('close',r))]);
}catch{process.stderr.write('Setup could not open the dedicated browsers. Check the configuration.\n');process.exitCode=1;}
