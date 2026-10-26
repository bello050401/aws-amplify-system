/** Only authentication/approval failure invalidates a visible session.
 * A business permission denial or a temporary network failure must not log out. */
export function isTerminalSessionError(code:unknown):boolean {
 return typeof code==='string'&&['SIGN_IN_REQUIRED','SESSION_EXPIRED','DEVICE_REVOKED','ACCOUNT_DISABLED','DEVICE_REJECTED','DEVICE_PENDING'].includes(code);
}
export const SESSION_INVALID_MESSAGE='BELLO_SESSION_INVALID';
