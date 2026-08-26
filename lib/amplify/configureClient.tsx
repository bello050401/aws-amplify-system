"use client";

import { Amplify } from "aws-amplify";
import outputs from "@/amplify_outputs.json";

Amplify.configure(outputs, { ssr: true });

/** Mount once near the root of any client tree that calls Amplify Auth/Data client-side. */
export function ConfigureAmplifyClientSide() {
  return null;
}
