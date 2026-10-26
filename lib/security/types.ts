/** All identities come from verified Cognito results, never a browser role/sub. */
export type Role = "Admins" | "ADMIN" | "EDITOR" | "VIEWER";
export type DeviceStatus = "pending" | "approved" | "rejected" | "revoked";
export type Row = { id: string; version: number; expiresAt?: number; [key: string]: unknown };
export type User = Row & { kind: "user"; sub: string; username: string; groups: string[]; enabled: boolean; generation: number; passkeyRegistered: boolean };
export type Device = Row & { kind: "device"; sub: string; name: string; publicKey: JsonWebKey; status: DeviceStatus; shared: boolean; generation: number; requestedAt: number; lastSeenAt: number; lastIp: string; userAgent: string; verificationCode: string };
export type Session = Row & { kind: "session"; origin: string; sub: string; deviceId: string; userGeneration: number; deviceGeneration: number; strongAt: number; createdAt: number; lastSeenAt: number; expiresAt: number; vault: string; revoked: boolean };
export type Challenge = Row & { kind: "challenge"; sessionId: string; nonce: string; digest: string; expiresAt: number };
export type Tokens = { access: string; id: string; refresh: string; expiresAt: number };
export type Identity = { sub: string; username: string; groups: string[]; tokens: Tokens };
export type Mutation = { row: Row; expected: number | null } | { deleteId: string; expected: number };
export interface Store {
  get<T extends Row>(id: string): Promise<T | undefined>;
  write(mutations: Mutation[]): Promise<void>;
  list(kind: string, cursor?: string): Promise<{ items: Row[]; cursor?: string }>;
  rate(key: string, limit: number, windowSeconds: number, now: number): Promise<void>;
}
export interface Vault { seal(value: unknown): Promise<string>; open<T>(value: string): Promise<T> }
export interface Provider {
  start(username: string, mode: "password" | "passkey", password?: string): Promise<{ flow?: unknown; options?: unknown; step?: string; identity?: Identity }>;
  finish(flow: unknown, answer: unknown): Promise<{ flow?: unknown; options?: unknown; step?: string; identity?: Identity }>;
  enrollStart(tokens: Tokens): Promise<unknown>;
  enrollFinish(tokens: Tokens, credential: unknown): Promise<void>;
  hasPasskey(tokens: Tokens): Promise<boolean>;
  refresh(tokens: Tokens): Promise<Identity>;
  revoke(tokens: Tokens): Promise<void>;
  createStaff?(username:string,role:'EDITOR'|'VIEWER'):Promise<{sub:string;temporaryPassword:string}>;
}
export type Context = { ip: string; userAgent: string; origin: string; target?: string; method?: string };
export type Proof = { challengeId: string; signature: string };
export class SecurityError extends Error {
  constructor(public code: string, public status = 403) { super(code); this.name = "SecurityError"; }
}
export const seconds = { minute: 60, day: 86400 };
export const ROLES: Role[] = ["Admins", "ADMIN", "EDITOR", "VIEWER"];
// Admins is the existing public-feature CMS group, not inventory/employee administration.
export function isAdmin(groups: string[]) { return groups.includes("ADMIN"); }
export function permitted(groups: string[]) { return ROLES.some(role => groups.includes(role)); }
export function versioned<T extends Row>(row: T): T { return { ...row, version: row.version + 1 }; }
