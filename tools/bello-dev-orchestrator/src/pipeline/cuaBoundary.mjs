import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {FROZEN_HTTP_MODE,FROZEN_HTTP_ACTIONS,FIXTURE_OPERATIONS,validateSaleFixtureContract,isIsolatedLocalMode,SALE_FIXTURE_SCHEMA_SHA256,SALE_FIXTURE_PATHS_SHA256} from './frozenHttpFixture.mjs';
export const CUA_CSP="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; media-src 'none'";
export const CUA_CSP_SHA256=crypto.createHash('sha256').update(CUA_CSP).digest('hex');
export const CUA_ACTIONS=Object.freeze(['navigate','reload','screenshot']);
const inside=(root,target)=>{const r=path.relative(root,target);return !r||!r.startsWith('..')&&!path.isAbsolute(r);};
export function validateCuaProfile(entry){
 const c=entry.desktopCua,s=entry.staging;
 const actions=s?.mode===FROZEN_HTTP_MODE?FROZEN_HTTP_ACTIONS:CUA_ACTIONS;if(s?.mode===FROZEN_HTTP_MODE){validateSaleFixtureContract(s);if(!isDeepStrictEqual(c?.requiredFixtureOperations,FIXTURE_OPERATIONS)||c?.postSchemaSha256!==SALE_FIXTURE_SCHEMA_SHA256||c?.servedPathsSha256!==SALE_FIXTURE_PATHS_SHA256)throw Error('Finite route/schema/operation scope must be pinned');}
 if(!c||c.driver!=='desktop-cua'||c.frozenReviewedFixture!==true||!isIsolatedLocalMode(s?.mode)||s.dataAdapter?.kind!=='fixture'||!s.hostBundle||c.bundleSha256!==s.hostBundle.sha256||c.cspSha256!==CUA_CSP_SHA256||!isDeepStrictEqual(c.allowedActions,actions)||!isDeepStrictEqual(c,s.desktopCua)||!isDeepStrictEqual(c,s.hostApproval?.desktopCua))throw Error('CUA requires the exact host-approved frozen fixture, CSP and action scope');
 if(!path.isAbsolute(c.directory??'')||!path.isAbsolute(c.sessionPath??''))throw Error('Absolute host CUA paths required');
 const roots=[fs.realpathSync(entry.repoPath),fs.realpathSync(s.dataRoot)],directory=fs.realpathSync(c.directory),session=path.join(fs.realpathSync(path.dirname(c.sessionPath)),path.basename(c.sessionPath));
 if(roots.some(root=>inside(root,directory)||inside(root,session)||inside(directory,root)))throw Error('CUA authorization and evidence inbox must be outside worker source and writable runtime data');
 return c;
}
export function cuaBoundaryProof({origin,applicationIsolation,settings}){
 const http=settings?.mode===FROZEN_HTTP_MODE;
 return {applicationIsolation,browserBoundary:{driver:'CUA',osIsolation:'not-asserted',origin,cspSha256:CUA_CSP_SHA256,...(settings?.desktopCua?{servedPathsSha256:settings.desktopCua.servedPathsSha256}:{}),...(http?{postSchemaSha256:SALE_FIXTURE_SCHEMA_SHA256}:{}),relayMethods:http?['GET','HEAD','POST /api/sale-candidates/desktop-jobs (finite synthetic schema)']:['GET','HEAD'],allowedActions:[...(http?FROZEN_HTTP_ACTIONS:CUA_ACTIONS)]}};
}
