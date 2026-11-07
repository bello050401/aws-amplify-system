/** Authentication results are read from Gmail's delivered headers, never supplied by the UI. */
export function trustedMercariNotification(input:{from:string;authenticationResults:string;labels?:string[]}):boolean{
 if(input.labels?.some(l=>l==='SENT'||l==='DRAFT'||l==='SPAM'||l==='TRASH'))return false;
 const address=(input.from.match(/<([^<>]+)>/)?.[1]??input.from).trim().toLowerCase();
 if(address!=='no-reply@mercari-shops.com')return false;
 const auth=input.authenticationResults.replace(/\r?\n[ \t]+/g,' ').toLowerCase();
 if(!/^\s*mx\.google\.com\s*;/.test(auth))return false;
 return /\bdmarc=pass\b[^;]*\bheader\.from=mercari-shops\.com(?=[;\s]|$)/.test(auth);
}
