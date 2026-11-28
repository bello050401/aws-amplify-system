export function wholesaleImageSource(uri:string,authenticatedOrigin?:string,headers?:Record<string,string>):{uri:string;headers?:Record<string,string>} {
 // Linked catalogue images can be hosted by third parties. BELLO credentials
 // belong exclusively to the authenticated BELLO origin.
 try{if(authenticatedOrigin&&new URL(uri).origin===new URL(authenticatedOrigin).origin)return {uri,...(headers?{headers}:{})};}catch{/* malformed images receive no credentials */}
 return {uri};
}
