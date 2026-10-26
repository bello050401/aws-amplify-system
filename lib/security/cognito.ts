import { createHmac,randomBytes } from "node:crypto";
import {CognitoIdentityProviderClient,AdminCreateUserCommand,AdminAddUserToGroupCommand,AdminDisableUserCommand} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { SecurityError, type Identity, type Provider, type Tokens } from "./types";

type AuthResult = { AuthenticationResult?: { AccessToken: string; IdToken: string; RefreshToken?: string; ExpiresIn: number }; ChallengeName?: string; ChallengeParameters?: Record<string, string>; Session?: string };
type Flow = { username: string; challenge: string; session: string; mode: "password" | "passkey" };
const allowed = new Set(["InitiateAuth", "RespondToAuthChallenge", "StartWebAuthnRegistration", "CompleteWebAuthnRegistration", "ListWebAuthnCredentials", "GetTokensFromRefreshToken", "RevokeToken"]);
export class CognitoProvider implements Provider {
  private accessVerifier;
  private idVerifier;
  constructor(readonly poolId: string, readonly clientId: string, readonly region: string, readonly clientSecret: string) {
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region) || !poolId.startsWith(region + "_")) throw new SecurityError("INVALID_COGNITO_CONFIG", 503);
    this.accessVerifier = CognitoJwtVerifier.create({ userPoolId: poolId, clientId, tokenUse: "access" });
    this.idVerifier = CognitoJwtVerifier.create({ userPoolId: poolId, clientId, tokenUse: "id" });
  }
  private secret(username: string) { return createHmac("sha256", this.clientSecret).update(username + this.clientId).digest("base64"); }
  private async call<T>(operation: string, body: unknown): Promise<T> {
    if (!allowed.has(operation)) throw new SecurityError("COGNITO_OPERATION_DENIED");
    const response = await fetch("https://cognito-idp." + this.region + ".amazonaws.com/", {
      method: "POST", headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityProviderService." + operation },
      body: JSON.stringify(body), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      // Deliberately never log upstream bodies; they can contain user identifiers.
      const error = await response.json().catch(() => ({})) as { __type?: string };
      if (error.__type?.endsWith("TooManyRequestsException")) throw new SecurityError("TOO_MANY_REQUESTS", 429);
      throw new SecurityError("COGNITO_REQUEST_FAILED", 401);
    }
    return response.json() as Promise<T>;
  }
  private async identity(r: NonNullable<AuthResult["AuthenticationResult"]>, refresh?: string): Promise<Identity> {
    const [access, id] = await Promise.all([this.accessVerifier.verify(r.AccessToken), this.idVerifier.verify(r.IdToken)]);
    if (access.sub !== id.sub || !r.RefreshToken && !refresh) throw new SecurityError("INVALID_TOKEN", 401);
    return { sub: access.sub, username: String(id.email ?? access.username),
      groups: (access["cognito:groups"] ?? []).filter((x): x is string => typeof x === "string"),
      tokens: { access: r.AccessToken, id: r.IdToken, refresh: r.RefreshToken ?? refresh!, expiresAt: access.exp } };
  }
  private async result(r: AuthResult, username: string, mode: Flow["mode"]) {
    if (r.AuthenticationResult) return { identity: await this.identity(r.AuthenticationResult) };
    if (!r.Session || !r.ChallengeName) throw new SecurityError("UNSUPPORTED_AUTHENTICATION", 401);
    if (mode === "passkey" && r.ChallengeName !== "WEB_AUTHN") throw new SecurityError("PASSKEY_NOT_AVAILABLE", 401);
    if (mode === "password" && !["NEW_PASSWORD_REQUIRED", "SOFTWARE_TOKEN_MFA", "SMS_MFA", "EMAIL_MFA"].includes(r.ChallengeName))
      throw new SecurityError("UNSUPPORTED_AUTHENTICATION", 401);
    const flow: Flow = { username: r.ChallengeParameters?.USERNAME ?? username, mode, challenge: r.ChallengeName, session: r.Session };
    return { flow, step: r.ChallengeName,
      options: r.ChallengeName === "WEB_AUTHN" ? JSON.parse(r.ChallengeParameters?.CREDENTIAL_REQUEST_OPTIONS ?? "{}") : undefined };
  }
  async start(username: string, mode: Flow["mode"], password?: string) {
    const parameters: Record<string, string> = { USERNAME: username, SECRET_HASH: this.secret(username) };
    if (mode === "password") {
      if (!password || password.length > 256) throw new SecurityError("LOGIN_FAILED", 401);
      parameters.PASSWORD = password;
    } else parameters.PREFERRED_CHALLENGE = "WEB_AUTHN";
    const r = await this.call<AuthResult>("InitiateAuth", { ClientId: this.clientId,
      AuthFlow: mode === "passkey" ? "USER_AUTH" : "USER_PASSWORD_AUTH", AuthParameters: parameters });
    return this.result(r, username, mode);
  }
  async finish(raw: unknown, answer: unknown) {
    const flow = raw as Flow;
    const fields: Record<string, string> = { USERNAME: flow.username, SECRET_HASH: this.secret(flow.username) };
    const field = ({ WEB_AUTHN: "CREDENTIAL", NEW_PASSWORD_REQUIRED: "NEW_PASSWORD", SOFTWARE_TOKEN_MFA: "SOFTWARE_TOKEN_MFA_CODE", SMS_MFA: "SMS_MFA_CODE", EMAIL_MFA: "EMAIL_MFA_CODE" } as Record<string, string>)[flow.challenge];
    if (!field) throw new SecurityError("UNSUPPORTED_AUTHENTICATION", 401);
    fields[field] = flow.challenge === "WEB_AUTHN" ? JSON.stringify(answer) : String(answer);
    const r = await this.call<AuthResult>("RespondToAuthChallenge", { ClientId: this.clientId, ChallengeName: flow.challenge, Session: flow.session, ChallengeResponses: fields });
    return this.result(r, flow.username, flow.mode);
  }
  async enrollStart(tokens: Tokens) {
    const result = await this.call<{ CredentialCreationOptions: unknown }>("StartWebAuthnRegistration", { AccessToken: tokens.access });
    return result.CredentialCreationOptions;
  }
  async enrollFinish(tokens: Tokens, credential: unknown) { await this.call("CompleteWebAuthnRegistration", { AccessToken: tokens.access, Credential: credential }); }
  async hasPasskey(tokens: Tokens) {
    const r = await this.call<{ Credentials?: unknown[] }>("ListWebAuthnCredentials", { AccessToken: tokens.access, MaxResults: 1 });
    return Boolean(r.Credentials?.length);
  }
  async refresh(tokens: Tokens) {
    const r = await this.call<AuthResult>("GetTokensFromRefreshToken", { ClientId: this.clientId, ClientSecret: this.clientSecret, RefreshToken: tokens.refresh });
    if (!r.AuthenticationResult) throw new SecurityError("SESSION_EXPIRED", 401);
    return this.identity(r.AuthenticationResult, tokens.refresh);
  }
  async revoke(tokens: Tokens) { await this.call("RevokeToken", { ClientId: this.clientId, ClientSecret: this.clientSecret, Token: tokens.refresh }); }
  async createStaff(username:string,role:'EDITOR'|'VIEWER') {
    if(!['EDITOR','VIEWER'].includes(role))throw new SecurityError('INVALID_STAFF_ROLE',400);
    const client=new CognitoIdentityProviderClient({region:this.region,maxAttempts:1});
    const temporaryPassword='Aa1!'+randomBytes(24).toString('base64url');
    let created=false;
    try{
      const result=await client.send(new AdminCreateUserCommand({UserPoolId:this.poolId,Username:username,TemporaryPassword:temporaryPassword,MessageAction:'SUPPRESS',ForceAliasCreation:false,UserAttributes:[{Name:'email',Value:username}]}));
      created=true;
      const sub=result.User?.Attributes?.find(a=>a.Name==='sub')?.Value;
      if(!sub)throw Error('Missing identity');
      await client.send(new AdminAddUserToGroupCommand({UserPoolId:this.poolId,Username:username,GroupName:role}));
      return{sub,temporaryPassword};
    }catch(error){
      if(created)await client.send(new AdminDisableUserCommand({UserPoolId:this.poolId,Username:username})).catch(()=>{});
      // Never return upstream request data, passwords or AWS diagnostics.
      throw new SecurityError((error as Error).name==='UsernameExistsException'?'STAFF_ALREADY_EXISTS':'STAFF_CREATION_UNCONFIRMED',409);
    }
  }
}
