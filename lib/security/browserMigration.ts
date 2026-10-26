/** Runs only after the server enables device security. No keys or passwords are read. */
export function clearLegacyBrowserCredentials() {
  if(typeof window==='undefined')return;
  const legacy=(key:string)=>key.startsWith('CognitoIdentityServiceProvider.')||key.startsWith('aws-amplify-federatedInfo')||key==='amplify-signin-with-hostedUI';
  for(const storage of [window.localStorage,window.sessionStorage]){
    for(const key of Object.keys(storage))if(legacy(key))storage.removeItem(key);
  }
  for(const item of document.cookie.split(';')){
    const name=item.trim().split('=')[0];
    if(!legacy(decodeURIComponent(name)))continue;
    for(const path of ['/','/inventory','/admin','/staff-app'])document.cookie=`${name}=; Path=${path}; Max-Age=0; Secure; SameSite=Strict`;
  }
}
