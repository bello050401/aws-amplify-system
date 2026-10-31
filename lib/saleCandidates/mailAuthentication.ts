/** Use Gmail's receiving-server result, not a sender-supplied Date or body claim. */
export function yahooSenderAuthenticated(headers:{name:string;value:string}[]):boolean {
 const result=headers.find(h=>h.name.toLowerCase()==='authentication-results'&&/^mx\.google\.com\s*;/i.test(h.value.trim()))?.value||'';
 return /(?:^|;)\s*dmarc=pass\b[^;]*\bheader\.from=(?:mail\.)?yahoo\.co\.jp(?=[\s;]|$)/i.test(result);
}
