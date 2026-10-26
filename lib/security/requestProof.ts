/** Shared canonical request format. Does not contain a token or request contents. */
export type RequestProof = { version: 1; at: number; nonce: string; binding: string; digest: string; signature: string };
export function requestProofMessage(origin: string, method: string, target: string, proof: Omit<RequestProof, "signature">) {
  return ["BELLO-HTTP-PROOF-v1", origin, method.toUpperCase(), target, String(proof.at), proof.nonce, proof.binding, proof.digest].join("\n");
}
