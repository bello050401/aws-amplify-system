// Hash-based inventory ID generation is deliberately unavailable in this browser
// fixture. The bundle imports only pure lot arithmetic; unused hashing is removed.
export function createHash():never {throw Error('NATIVE_FIXTURE_HASHING_UNAVAILABLE');}
