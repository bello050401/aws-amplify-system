import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signInValidationDevice, signInValidationSession, refreshValidationSession, validateValidationToken, loginErrorCode, VALIDATION_CLIENT, VALIDATION_ISSUER } from '../src/validationLogin.mjs';

const token = (overrides = {}) => {
  const payload = {
    iss: VALIDATION_ISSUER,
    aud: VALIDATION_CLIENT,
    token_use: 'id',
    exp: Math.floor(Date.now() / 1000) + 3600,
    'cognito:groups': ['PHOTO_DEVICE'],
    ...overrides,
  };
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.x`;
};

test('login failure messages classify safe codes without returning SDK details or secrets', () => {
  assert.equal(loginErrorCode({ name: 'NotAuthorizedException', message: 'secret-password' }), 'INVALID_CREDENTIALS');
  assert.equal(loginErrorCode({ code: 'ENOTFOUND', hostname: 'private-host' }), 'NETWORK_ERROR');
  assert.equal(loginErrorCode({ code: 'PHOTO_PERMISSION_REQUIRED' }), 'PHOTO_PERMISSION_REQUIRED');
  assert.equal(loginErrorCode({ name: 'TooManyRequestsException' }), 'TOO_MANY_REQUESTS');
  assert.equal(loginErrorCode({ message: 'private-token' }), 'LOGIN_FAILED');
});

test('accepts only current isolated PHOTO_DEVICE ID tokens', () => {
  assert.equal(validateValidationToken(token()), true);
  assert.equal(validateValidationToken(token({ iss: 'https://other.example' })), false);
  assert.equal(validateValidationToken(token({ aud: 'other' })), false);
  assert.equal(validateValidationToken(token({ token_use: 'access' })), false);
  assert.equal(validateValidationToken(token({ 'cognito:groups': ['ADMIN'] })), false);
  assert.equal(validateValidationToken(token({ exp: Math.floor(Date.now() / 1000) + 30 })), false);
});

test('sign-in is pinned to dedicated pool, client, flow, and user', async () => {
  const client = { send: async command => {
    assert.deepEqual(command.input, {
      ClientId: VALIDATION_CLIENT,
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: 'photo-device-e2e', PASSWORD: 'test-only' },
    });
    return { AuthenticationResult: { IdToken: token() } };
  } };
  assert.equal(await signInValidationDevice('test-only', client), await signInValidationDevice('test-only', client));
});

test('missing password or challenge cannot launch upload', async () => {
  await assert.rejects(signInValidationDevice('', { send: () => {} }), /Password/);
  await assert.rejects(signInValidationDevice('test-only', { send: async () => ({ ChallengeName: 'NEW_PASSWORD_REQUIRED' }) }), /usable/);
});

test('a successful sign-in retains a refresh token and refresh stays pinned to the validation client', async () => {
  const client = { send: async command => {
    if (command.input.AuthFlow === 'USER_PASSWORD_AUTH')
      return { AuthenticationResult: { IdToken: token(), RefreshToken: 'refresh-secret' } };
    assert.deepEqual(command.input, {
      ClientId: VALIDATION_CLIENT,
      AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: 'refresh-secret' },
    });
    return { AuthenticationResult: { IdToken: token() } };
  } };
  const first = await signInValidationSession('test-only', client);
  assert.equal(first.refreshToken, 'refresh-secret');
  assert.equal((await refreshValidationSession(first.refreshToken, client)).refreshToken, 'refresh-secret');
  await assert.rejects(refreshValidationSession('', client), /missing/);
});

test('public login accepts an assigned photo user and completes a temporary password challenge', async () => {
  const { respondToLoginChallenge } = await import('../src/validationLogin.mjs');
  const first = await signInValidationSession('temporary', { send: async command => {
    assert.equal(command.constructor.name, 'InitiateAuthCommand');
    assert.equal(command.input.AuthParameters.USERNAME, 'staff-photo');
    assert.equal(command.input.UserPoolId, undefined);
    return { ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 'private-session' };
  } }, 'staff-photo', true);
  assert.equal(first.challengeName, 'NEW_PASSWORD_REQUIRED');
  const result = await respondToLoginChallenge({ ...first, answer: 'new-password' }, { send: async command => {
    assert.equal(command.constructor.name, 'RespondToAuthChallengeCommand');
    assert.equal(command.input.ChallengeResponses.USERNAME, 'staff-photo');
    assert.equal(command.input.ChallengeResponses.NEW_PASSWORD, 'new-password');
    return { AuthenticationResult: { IdToken: token(), RefreshToken: 'private-refresh' } };
  } });
  assert.equal(result.refreshToken, 'private-refresh');
  await assert.rejects(respondToLoginChallenge({ ...first, challengeName: 'OTHER', answer: 'x' }, {}), /Invalid/);
});
