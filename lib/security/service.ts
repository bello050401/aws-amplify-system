import { randomInt } from "node:crypto";
import {isIP} from 'node:net';
import { requestProofMessage, type RequestProof } from "./requestProof";
import { hasBusinessPermission } from "./accessPolicy";
import { hash, keyId, proofMessage, publicKey, randomId, safeText, verifyProof } from "./crypto";
import { SecurityError, isAdmin, permitted, seconds, versioned, type Challenge, type Context, type Device, type Identity, type Proof, type Provider, type Row, type Session, type Store, type Tokens, type User, type Vault } from "./types";

type Flow = Row & { kind: "flow"; vault: string; expiresAt: number };
type FlowData = { provider: unknown; mode: "password" | "passkey"; key: JsonWebKey; name: string; shared: boolean; origin: string };
type Actor = { session: Session; user: User; device: Device };
const edgeFields=(ctx:Context,at:number)=>({edgeRequestId:ctx.edgeRequestId??'',edgeAt:at,edgeTarget:(ctx.target??'/api/security').split('?')[0],edgeMethod:ctx.method??'POST'});
export type Action =
  | { action: "status" } | { action: "enrollStart" } | { action: "enrollFinish"; credential: unknown }
  | { action: "businessProbe" } | { action: "logout" }
  | { action: "devices"; cursor?: string } | { action: "users"; cursor?: string } | { action: "events"; cursor?: string }
  | { action: "approve" | "reject" | "revoke"; deviceId: string; expectedVersion: number; verificationCode?: string; personConfirmed?: boolean }
  | { action: "disableUser" | "enableUser" | "logoutUser"; sub: string; expectedVersion: number }
  | { action:'createUser'; username:string; role:'EDITOR'|'VIEWER'; personConfirmed:boolean };

/** Independent server-side auth boundary. No product/EC write code or frontend tokens. */
export class SecurityService {
  constructor(readonly store: Store, readonly vault: Vault, readonly provider: Provider,
    readonly origin: string, readonly now: () => number = () => Math.floor(Date.now() / 1000),
    readonly enrichAudit?: (rows:Row[])=>Promise<Row[]>) {}

  async audit(event: string, ctx: Context, result: string, sub?: string, deviceId?: string) {
    const time = this.now();
    // Only explicit metadata. Never spread a request, error, token, credential or key.
    await this.store.write([{ expected: null, row: {
      id: "event#" + time.toString().padStart(12, "0") + "#" + randomId(),
      kind: "event", version: 1, at: time, event, result, ...edgeFields(ctx,time),
      sub: sub ?? null, deviceId: deviceId ?? null, ip: safeText(ctx.ip, 64),
      userAgent: safeText(ctx.userAgent, 240), target: safeText((ctx.target ?? "/api/security").split("?")[0],240), method:safeText(ctx.method??"POST",10),
      expiresAt: time + 90 * seconds.day,
    } }]);
    if (process.env.SECURITY_DEPLOYMENT) console.info(JSON.stringify({ type: "security-audit", at: time, event, result, sub: sub ?? null, deviceId: deviceId ?? null, ip: safeText(ctx.ip, 64) }));
  }

  async begin(input: { username: string; mode: "password" | "passkey"; password?: string; key: unknown; name: string; shared: boolean }, ctx: Context) {
    this.checkOrigin(ctx);
    const username = safeText(input.username, 256).trim();
    if (!username || !["password", "passkey"].includes(input.mode)) throw new SecurityError("INVALID_LOGIN", 400);
    const key = publicKey(input.key);
    // Unknown hosting metadata must not put every employee in one 30-attempt
    // bucket. The per-account limit always applies; an edge WAF covers floods.
    if(isIP(ctx.ip))await this.store.rate("login-ip#" + hash(ctx.ip), 30, 300, this.now());
    await this.store.rate("login-user#" + hash(username.toLowerCase()), 10, 300, this.now());
    let result: Awaited<ReturnType<Provider["start"]>>;
    try { result = await this.provider.start(username, input.mode, input.password); }
    catch { await this.audit("LOGIN_FAILED", ctx, "denied"); throw new SecurityError("LOGIN_FAILED", 401); }
    const data: FlowData = { provider: result.flow, mode: input.mode, key, name: safeText(input.name, 80).trim() || "登録端末", shared: input.shared === true, origin: ctx.origin };
    if (result.identity) return this.openSession(result.identity, data, ctx);
    return this.saveFlow(data, result.options, result.step);
  }

  async finish(flowToken: string, answer: unknown, ctx: Context) {
    this.checkOrigin(ctx);
    const flow = await this.store.get<Flow>("flow#" + hash(flowToken));
    if (!flow || flow.expiresAt <= this.now()) throw new SecurityError("AUTH_FLOW_EXPIRED", 401);
    const data = await this.vault.open<FlowData>(flow.vault);
    if (data.origin !== ctx.origin) throw new SecurityError("INVALID_ORIGIN");
    // One use, including failed answers. No concurrent replay of a Cognito challenge.
    await this.store.write([{ deleteId: flow.id, expected: flow.version }]);
    let result: Awaited<ReturnType<Provider["finish"]>>;
    try { result = await this.provider.finish(data.provider, answer); }
    catch { await this.audit("LOGIN_FAILED", ctx, "denied"); throw new SecurityError("LOGIN_FAILED", 401); }
    if (result.identity) return this.openSession(result.identity, data, ctx);
    return this.saveFlow({ ...data, provider: result.flow }, result.options, result.step);
  }

  private async saveFlow(data: FlowData, options: unknown, step?: string) {
    const flowToken = randomId();
    await this.store.write([{ expected: null, row: { id: "flow#" + hash(flowToken), kind: "flow", version: 1, vault: await this.vault.seal(data), expiresAt: this.now() + 180 } }]);
    return { flowToken, options, step, sessionToken: undefined as string | undefined };
  }

  private async openSession(identity: Identity, data: FlowData, ctx: Context) {
    if (!permitted(identity.groups)) throw new SecurityError("NO_STAFF_ROLE");
    const time = this.now(), userId = "user#" + identity.sub;
    const oldUser = await this.store.get<User>(userId);
    if (oldUser && !oldUser.enabled) throw new SecurityError("ACCOUNT_DISABLED");
    const hasPasskey = await this.provider.hasPasskey(identity.tokens);
    const user: User = {
      id: userId, kind: "user", version: (oldUser?.version ?? 0) + 1, sub: identity.sub,
      username: identity.username, groups: identity.groups, enabled: true,
      generation: oldUser?.generation ?? 1, passkeyRegistered: hasPasskey,
      ...(oldUser?.revokedBefore ? {revokedBefore:oldUser.revokedBefore} : {}),
    };
    const deviceId = "device#" + identity.sub + "#" + keyId(data.key);
    const oldDevice = await this.store.get<Device>(deviceId);
    // Rejected/revoked devices are never silently put back into pending/approved.
    const device: Device = oldDevice ? { ...versioned(oldDevice), username: identity.username, lastSeenAt: time, lastIp: safeText(ctx.ip, 64), userAgent: safeText(ctx.userAgent, 240), ...edgeFields(ctx,time) } : {
      id: deviceId, kind: "device", version: 1, sub: identity.sub, publicKey: data.key,
      name: data.name, username: identity.username, shared: data.shared, status: "pending", generation: 1,
      requestedAt: time, lastSeenAt: time, lastIp: safeText(ctx.ip, 64), ...edgeFields(ctx,time),
      userAgent: safeText(ctx.userAgent, 240), verificationCode: String(randomInt(100000, 1000000)),
    };
    const sessionToken = randomId();
    const session: Session = {
      id: "session#" + hash(sessionToken), kind: "session", origin: this.origin, version: 1, sub: user.sub, deviceId,
      userGeneration: user.generation, deviceGeneration: device.generation,
      strongAt: data.mode === "passkey" ? time : 0, createdAt: time, lastSeenAt: time,
      // Bootstrap/password sessions cannot become persistent privileged sessions.
      expiresAt: time + (data.mode === "password" ? 15 * 60 : device.shared ? 8 * 3600 : 30 * seconds.day),
      vault: await this.vault.seal(identity.tokens), revoked: false,
    };
    await this.store.write([
      { row: user, expected: oldUser?.version ?? null },
      { row: device, expected: oldDevice?.version ?? null },
      { row: session, expected: null },
    ]);
    await this.audit(oldDevice ? "LOGIN_SUCCEEDED" : "DEVICE_REQUESTED", ctx, device.status, user.sub, deviceId);
    return { sessionToken, maxAge: session.expiresAt - time, flowToken: undefined, step: undefined, options: undefined };
  }

  private checkOrigin(ctx: Context) { if (ctx.origin !== this.origin) throw new SecurityError("INVALID_ORIGIN"); }
  private async actor(token: string): Promise<Actor> {
    const session = await this.store.get<Session>("session#" + hash(token));
    if (!session || session.origin !== this.origin || session.revoked || session.expiresAt <= this.now()) throw new SecurityError("SESSION_EXPIRED", 401);
    const [user, device] = await Promise.all([this.store.get<User>("user#" + session.sub), this.store.get<Device>(session.deviceId)]);
    if (!user || !user.enabled || user.generation !== session.userGeneration || !permitted(user.groups)) throw new SecurityError("ACCOUNT_DISABLED");
    if (!device || device.generation !== session.deviceGeneration) throw new SecurityError("DEVICE_REVOKED");
    const idleLimit = device.shared ? 30 * 60 : 14 * seconds.day;
    if (session.lastSeenAt + idleLimit <= this.now()) throw new SecurityError("SESSION_EXPIRED", 401);
    return { session, user, device };
  }

  async challenge(token: string, digest: string, ctx: Context) {
    this.checkOrigin(ctx);
    if (!/^[A-Za-z0-9_-]{43}$/.test(digest)) throw new SecurityError("INVALID_DIGEST", 400);
    const { session } = await this.actor(token);
    await this.store.rate(session.id, 120, 60, this.now());
    const row: Challenge = { id: "challenge#" + randomId(), kind: "challenge", version: 1, sessionId: session.id, nonce: randomId(), digest, expiresAt: this.now() + 60 };
    await this.store.write([{ row, expected: null }]);
    return { challengeId: row.id, message: proofMessage(this.origin, row.nonce, digest) };
  }

  async perform(token: string, payload: string, proof: Proof, ctx: Context): Promise<unknown> {
    this.checkOrigin(ctx);
    const actor = await this.actor(token);
    const c = await this.store.get<Challenge>(proof.challengeId);
    if (!c || c.sessionId !== actor.session.id || c.expiresAt <= this.now() || c.digest !== hash(payload) ||
      !verifyProof(actor.device.publicKey, proofMessage(this.origin, c.nonce, c.digest), proof.signature))
      throw new SecurityError("INVALID_DEVICE_PROOF");
    await this.store.write([{ deleteId: c.id, expected: c.version }]);
    const body = JSON.parse(payload) as Action;
    if (!body || typeof body.action !== "string") throw new SecurityError("INVALID_ACTION", 400);
    const { user, session, device } = actor;
    if (body.action === "logout") {
      await this.store.write([{ row: { ...versioned(session), revoked: true }, expected: session.version }]);
      try { await this.provider.revoke(await this.vault.open<Tokens>(session.vault)); } catch { /* Local revocation is authoritative. */ }
      await this.audit("LOGOUT", ctx, "ok", user.sub, device.id);
      return { ok: true };
    }
    if (body.action === "status") {
      return { username: user.username, status: device.status, passkeyRegistered: user.passkeyRegistered,
        needsPasskeyLogin: session.strongAt === 0, name: device.name, shared: device.shared,
        verificationCode: device.verificationCode, admin: isAdmin(user.groups),
        approved: device.status === "approved" && session.strongAt > 0 && user.passkeyRegistered,
        requestBinding: hash(session.id) };
    }
    if (device.status === "rejected") throw new SecurityError("DEVICE_REJECTED");
    if (device.status === "revoked") throw new SecurityError("DEVICE_REVOKED");
    if (body.action === "enrollStart" || body.action === "enrollFinish") {
      if (this.now() - (session.strongAt || session.createdAt) > 300) throw new SecurityError("REAUTHENTICATE", 401);
      const tokens = await this.tokens(actor);
      // Password-only recovery must never add an attacker passkey to an enrolled account.
      if (session.strongAt === 0 && await this.provider.hasPasskey(tokens)) throw new SecurityError("PASSKEY_REQUIRED");
      if (body.action === "enrollStart") return { options: await this.provider.enrollStart(tokens) };
      await this.provider.enrollFinish(tokens, body.credential);
      const enrolledUser = await this.store.get<User>(user.id);
      if (!enrolledUser || !enrolledUser.enabled || enrolledUser.generation !== session.userGeneration) throw new SecurityError("ACCOUNT_DISABLED");
      await this.store.write([{ row: { ...versioned(enrolledUser), passkeyRegistered: true }, expected: enrolledUser.version }]);
      await this.audit("PASSKEY_REGISTERED", ctx, "ok", user.sub, device.id);
      return { ok: true, requiresPasskeyLogin: true };
    }
    await this.tokens(actor);
    const currentActor = await this.actor(token);
    this.requireApproved(currentActor);
    if (body.action === "businessProbe") {
      await this.touch(currentActor, ctx);
      // Preserve group names. Admins (feature CMS) does not imply inventory ADMIN.
      return { ok: true, groups: currentActor.user.groups };
    }
    this.requireAdmin(currentActor);
    if(body.action==='createUser'){
      const username=safeText(body.username,256).trim().toLowerCase();
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)||!['EDITOR','VIEWER'].includes(body.role)||body.personConfirmed!==true)throw new SecurityError('INVALID_STAFF_INPUT',400);
      if(!this.provider.createStaff)throw new SecurityError('STAFF_CREATION_UNAVAILABLE',503);
      await this.store.rate('provision#'+user.sub,5,3600,this.now());
      const request={id:'provision#'+hash(username),kind:'provision',version:1,status:'started',createdAt:this.now(),expiresAt:this.now()+7*seconds.day};
      await this.store.write([{expected:null,row:request}]);
      try{
        const result=await this.provider.createStaff(username,body.role);
        await this.store.write([{expected:1,row:{...request,version:2,status:'complete'}},{expected:null,row:{id:'user#'+result.sub,kind:'user',version:1,sub:result.sub,username,groups:[body.role],enabled:true,generation:1,passkeyRegistered:false}}]);
        await this.audit('STAFF_CREATED',ctx,'ok',result.sub);
        return{ok:true,username,temporaryPassword:result.temporaryPassword};
      }catch(error){await this.audit('STAFF_CREATION_UNCONFIRMED',ctx,'check-required');throw error;}
    }
    if (["devices", "users", "events"].includes(body.action)) {
      const kind = body.action === "devices" ? "device" : body.action === "users" ? "user" : "event";
      const page = await this.store.list(kind, "cursor" in body ? body.cursor : undefined);
      // Enrichment happens only after fresh ADMIN authentication. It never
      // changes access decisions, inventory reads, or stored device versions.
      const rows=kind!=='user'&&this.enrichAudit?await this.enrichAudit(page.items):page.items;
      return { ...page, items: rows.map(row => {
        // The code must come from the staff member, not the approval response.
        const safe = { ...row };
        delete safe.publicKey; delete safe.vault; delete safe.verificationCode;
        return safe;
      }) };
    }
    if (body.action === "approve" || body.action === "reject" || body.action === "revoke") {
      const target = await this.store.get<Device>(body.deviceId);
      if (!target || target.version !== body.expectedVersion) throw new SecurityError("STALE_RECORD", 409);
      // Approval is only of an existing pending request. A fresh key/request is needed after rejection/revocation.
      if (body.action === "approve" && (target.status !== "pending" || body.personConfirmed !== true || body.verificationCode !== target.verificationCode))
        throw new SecurityError("PERSON_VERIFICATION_REQUIRED", 400);
      if (body.action === "reject" && target.status !== "pending") throw new SecurityError("INVALID_TRANSITION", 409);
      // Avoid destroying the administrator's only working control channel in one click.
      if (target.id === device.id) throw new SecurityError("CANNOT_REVOKE_CURRENT_ADMIN_DEVICE", 409);
      const next = { ...versioned(target), status: body.action === "approve" ? "approved" : body.action === "reject" ? "rejected" : "revoked",
        generation: target.generation + (body.action === "revoke" ? 1 : 0), decidedAt: this.now(), decidedBy: user.sub };
      await this.store.write([{ row: next, expected: target.version }]);
      await this.audit("DEVICE_" + body.action.toUpperCase(), ctx, String(next.status), target.sub, target.id);
      return { ok: true };
    }
    if (body.action === "disableUser" || body.action === "enableUser" || body.action === "logoutUser") {
      const target = await this.store.get<User>("user#" + body.sub);
      if (!target || target.version !== body.expectedVersion) throw new SecurityError("STALE_RECORD", 409);
      if (target.sub === user.sub) throw new SecurityError("CANNOT_DISABLE_CURRENT_ADMIN", 409);
      await this.store.write([{ row: { ...versioned(target), generation: target.generation + 1, revokedBefore: this.now(), enabled: body.action === "enableUser" ? true : body.action === "disableUser" ? false : target.enabled }, expected: target.version }]);
      await this.audit(body.action === "enableUser" ? "ACCOUNT_ENABLED" : body.action === "disableUser" ? "ACCOUNT_DISABLED" : "ALL_SESSIONS_REVOKED", ctx, "ok", target.sub);
      return { ok: true };
    }
    throw new SecurityError("UNKNOWN_ACTION", 400);
  }

  /** Server-only authorization for real business routes. No bearer/JWT is returned to the client. */
  async authorizeRequest(token: string, request: { method: string; target: string; digest: string; proof: RequestProof }, ctx: Context) {
    this.checkOrigin(ctx);
    const actor = await this.actor(token), p = request.proof;
    this.requireApproved(actor);
    if (!p || p.version !== 1 || !Number.isSafeInteger(p.at) || Math.abs(this.now() - p.at) > 30 ||
      !/^[A-Za-z0-9_-]{43}$/.test(p.nonce) || !/^[A-Za-z0-9_-]{43}$/.test(p.digest) ||
      p.binding !== hash(actor.session.id) || p.digest !== request.digest ||
      !request.target.startsWith("/") || /[\r\n#]/.test(request.target) ||
      !verifyProof(actor.device.publicKey, requestProofMessage(this.origin, request.method, request.target, p), p.signature))
      throw new SecurityError("INVALID_DEVICE_PROOF");
    // TTL is cleanup only; CAS prevents concurrent reuse even before expiry deletion.
    await this.store.write([{ expected: null, row: { id: "http-proof#" + hash(actor.session.id + p.nonce), kind: "http-proof", version: 1, expiresAt: this.now() + 120 } }]);
    const tokens = await this.tokens(actor);
    const current = await this.actor(token);
    this.requireApproved(current);
    await this.touch(current, ctx);
    if(!['GET','HEAD','OPTIONS'].includes(request.method))await this.audit('BUSINESS_WRITE_AUTHORIZED',{...ctx,target:request.target,method:request.method},'authorized',current.user.sub,current.device.id);
    return { sub: current.user.sub, username: current.user.username, groups: current.user.groups,
      deviceId: current.device.id, sessionId: current.session.id, tokens };
  }

  /** Explicit scope check reused by HTTP and desktop gateway operations. */
  async serverTokens(token:string,expected:{sub:string;deviceId:string}) {
    const actor=await this.actor(token);this.requireApproved(actor);
    if(actor.user.sub!==expected.sub||actor.device.id!==expected.deviceId)throw new SecurityError('DEVICE_PROOF_REQUIRED');
    const tokens=await this.tokens(actor);
    this.requireApproved(await this.actor(token));
    return tokens;
  }

  /** Explicit scope check reused by HTTP and desktop gateway operations. */
  requireBusinessPermission(groups: string[], area: "inventory" | "featureCms", operation: "read" | "write" | "admin") {
    if (!hasBusinessPermission(groups, area, operation)) throw new SecurityError("INSUFFICIENT_PERMISSION");
  }

  private requireApproved({ user, device, session }: Actor) {
    if (device.status !== "approved") throw new SecurityError("DEVICE_PENDING");
    if (!user.passkeyRegistered || !session.strongAt) throw new SecurityError("PASSKEY_REQUIRED");
  }
  private requireAdmin(actor: Actor) {
    if (!isAdmin(actor.user.groups)) throw new SecurityError("ADMIN_REQUIRED");
    if (this.now() - actor.session.strongAt > 300) throw new SecurityError("REAUTHENTICATE", 401);
  }
  private async touch({ session, device }: Actor, ctx: Context) {
    if (this.now() - session.lastSeenAt < 60) return;
    try { await this.store.write([
      { row: { ...versioned(session), lastSeenAt: this.now() }, expected: session.version },
      { row: { ...versioned(device), lastSeenAt: this.now(), lastIp: safeText(ctx.ip, 64), userAgent: safeText(ctx.userAgent, 240), ...edgeFields(ctx,this.now()) }, expected: device.version },
    ]); } catch (error) {
      // Parallel image/API requests may update activity first. Never overwrite a
      // concurrent revocation or token rotation with stale session fields.
      if (!(error instanceof SecurityError) || error.code !== "STALE_RECORD") throw error;
      const [currentSession, currentDevice, user] = await Promise.all([
        this.store.get<Session>(session.id), this.store.get<Device>(device.id), this.store.get<User>("user#" + session.sub),
      ]);
      if (!currentSession || currentSession.revoked || currentSession.expiresAt <= this.now() ||
        !user?.enabled || user.generation !== session.userGeneration ||
        !currentDevice || currentDevice.status !== "approved" || currentDevice.generation !== session.deviceGeneration)
        throw new SecurityError("DEVICE_REVOKED");
    }
  }
  private async tokens(actor: Actor, attempt = 0): Promise<Tokens> {
    const tokens = await this.vault.open<Tokens>(actor.session.vault);
    if (tokens.expiresAt > this.now() + 30) return tokens;
    // Rotation must be serialized across workers. CAS a lease before using the old refresh token.
    const lease = { ...versioned(actor.session), refreshLeaseUntil: this.now() + 30 };
    const waitForRefresh = async () => {
      if (attempt >= 12) throw new SecurityError("RETRY_LATER", 409);
      await new Promise(resolve => setTimeout(resolve, 150));
      const session = await this.store.get<Session>(actor.session.id);
      const user = await this.store.get<User>(actor.user.id);
      const device = await this.store.get<Device>(actor.device.id);
      if (!session || session.revoked || !user?.enabled || user.generation !== session.userGeneration ||
        !device || device.generation !== session.deviceGeneration) throw new SecurityError("ACCOUNT_DISABLED");
      return this.tokens({ session, user, device }, attempt + 1);
    };
    if (Number(actor.session.refreshLeaseUntil ?? 0) > this.now()) return waitForRefresh();
    try { await this.store.write([{ row: lease, expected: actor.session.version }]); }
    catch (error) {
      if (error instanceof SecurityError && error.code === "STALE_RECORD") return waitForRefresh();
      throw error;
    }
    const refreshed = await this.provider.refresh(tokens);
    if (refreshed.sub !== actor.user.sub || !permitted(refreshed.groups)) throw new SecurityError("ACCOUNT_DISABLED");
    const freshUser = await this.store.get<User>(actor.user.id);
    if (!freshUser || !freshUser.enabled || freshUser.generation !== actor.session.userGeneration) throw new SecurityError("ACCOUNT_DISABLED");
    await this.store.write([
      { row: { ...versioned(lease), vault: await this.vault.seal(refreshed.tokens), refreshLeaseUntil: 0 }, expected: lease.version },
      { row: { ...versioned(freshUser), groups: refreshed.groups }, expected: freshUser.version },
    ]);
    return refreshed.tokens;
  }
}
