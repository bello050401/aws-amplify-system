export type DeviceProofInput={url:string;method:string;body:string;token:string};
export function windowsDeviceProof(input:DeviceProofInput,spawnImpl?:typeof import('node:child_process').spawn):Promise<Record<string,string>>;
