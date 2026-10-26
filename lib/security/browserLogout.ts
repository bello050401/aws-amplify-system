"use client";
import { signOut as legacySignOut } from "aws-amplify/auth";
export async function signOut() {
  if(process.env.BELLO_DEVICE_SECURITY!=="enforced")return legacySignOut();
  // Reuse the signed security action; never silently keep the server session alive.
  window.location.assign("/security?logout=1");
  await new Promise<void>(()=>{});
}
