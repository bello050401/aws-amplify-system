import { CognitoIdentityProviderClient, InitiateAuthCommand, RespondToAuthChallengeCommand } from '@aws-sdk/client-cognito-identity-provider';
import { isMainModule } from './isMainModule.mjs';

export const VALIDATION_POOL = 'us-west-2_bKfdql8QT';
export const VALIDATION_CLIENT = '3nm24ejtua3inrg0sdmpbn2vqs';
export const VALIDATION_USER = 'photo-device-e2e';
export const VALIDATION_ISSUER = `https://cognito-idp.us-west-2.amazonaws.com/${VALIDATION_POOL}`;

export function validateValidationToken(token, nowSeconds = Date.now() / 1000) {
  if (typeof token !== 'string' || token.split('.').length !== 3) return false;
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return claims.iss === VALIDATION_ISSUER
      && claims.aud === VALIDATION_CLIENT
      && claims.token_use === 'id'
      && Number.isFinite(claims.exp) && claims.exp > nowSeconds + 120
      && Array.isArray(claims['cognito:groups'])
      && claims['cognito:groups'].includes('PHOTO_DEVICE');
  } catch { return false; }
}

export async function signInValidationDevice(password, client) {
  return (await signInValidationSession(password, client)).idToken;
}

export async function signInValidationSession(password, client, username = VALIDATION_USER, allowChallenge = false) {
  if (!password) throw new Error('Password was not entered');
  if (!username?.trim()) throw new Error('Username was not entered');
  const response = await client.send(new InitiateAuthCommand({
    ClientId: VALIDATION_CLIENT,
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: username.trim(), PASSWORD: password },
  }));
  return readLoginResponse(response, username.trim(), allowChallenge);
}

function readLoginResponse(response, username, allowChallenge) {
  if (allowChallenge && ['NEW_PASSWORD_REQUIRED', 'SMS_MFA', 'SOFTWARE_TOKEN_MFA'].includes(response.ChallengeName) && response.Session)
    return { challengeName: response.ChallengeName, session: response.Session,
      username: response.ChallengeParameters?.USER_ID_FOR_SRP ?? username };
  if (response.ChallengeName || !validateValidationToken(response.AuthenticationResult?.IdToken)) {
    throw Object.assign(new Error('Validation sign-in did not return a usable PHOTO_DEVICE ID token'), { code: 'PHOTO_PERMISSION_REQUIRED' });
  }
  return { idToken: response.AuthenticationResult.IdToken, refreshToken: response.AuthenticationResult.RefreshToken ?? null };
}

export async function respondToLoginChallenge({ challengeName, session, username, answer }, client) {
  const key = { NEW_PASSWORD_REQUIRED: 'NEW_PASSWORD', SMS_MFA: 'SMS_MFA_CODE', SOFTWARE_TOKEN_MFA: 'SOFTWARE_TOKEN_MFA_CODE' }[challengeName];
  if (!key || !session || !username || !answer) throw new Error('Invalid sign-in challenge');
  const response = await client.send(new RespondToAuthChallengeCommand({ ClientId: VALIDATION_CLIENT,
    ChallengeName: challengeName, Session: session, ChallengeResponses: { USERNAME: username, [key]: answer } }));
  return readLoginResponse(response, username, true);
}

export async function refreshValidationSession(refreshToken, client) {
  if (!refreshToken) throw new Error('Refresh token is missing');
  const response = await client.send(new InitiateAuthCommand({
    ClientId: VALIDATION_CLIENT,
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  }));
  if (response.ChallengeName || !validateValidationToken(response.AuthenticationResult?.IdToken))
    throw new Error('Refresh did not return a usable PHOTO_DEVICE ID token');
  return { idToken: response.AuthenticationResult.IdToken, refreshToken: response.AuthenticationResult.RefreshToken ?? refreshToken };
}

async function main() {
  // Password arrives from a private local prompt over stdin, never argv or a file.
  let password = '';
  for await (const chunk of process.stdin) password += chunk.toString('utf8');
  password = password.replace(/[\r\n]+$/, '');
  const refreshing = process.argv.includes('--refresh');
  // Public Cognito operations do not resolve or need AWS IAM credentials.
  const client = new CognitoIdentityProviderClient({ region: 'us-west-2' });
  const input = !refreshing && process.argv.includes('--session') ? JSON.parse(password) : null;
  const result = refreshing
    ? await refreshValidationSession(password, client)
    : input?.challengeName ? await respondToLoginChallenge(input, client)
    : await signInValidationSession(input?.password ?? password, client, input?.username ?? VALIDATION_USER, Boolean(input));
  password = '';
  process.stdout.write(process.argv.includes('--session') || process.argv.includes('--refresh')
    ? JSON.stringify(result) : result.idToken);
}

export function loginErrorCode(error) {
  if (error?.code === 'PHOTO_PERMISSION_REQUIRED') return 'PHOTO_PERMISSION_REQUIRED';
  if (['NotAuthorizedException', 'UserNotFoundException'].includes(error?.name)) return 'INVALID_CREDENTIALS';
  if (error?.name === 'UserNotConfirmedException') return 'ACCOUNT_NOT_CONFIRMED';
  if (error?.name === 'PasswordResetRequiredException') return 'PASSWORD_RESET_REQUIRED';
  if (['TooManyRequestsException', 'LimitExceededException'].includes(error?.name)) return 'TOO_MANY_REQUESTS';
  if (['TimeoutError', 'NetworkingError', 'RequestTimeout'].includes(error?.name)
      || ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error?.code)) return 'NETWORK_ERROR';
  return 'LOGIN_FAILED';
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    // Do not echo AWS errors, which can contain request details.
    if (process.argv.includes('--session') || process.argv.includes('--refresh'))
      process.stdout.write(JSON.stringify({ errorCode: loginErrorCode(error) }));
    process.stderr.write('ログインできませんでした。ユーザー名・パスワード・インターネット接続を確認してください。\n');
    process.exitCode = 1;
  });
}
