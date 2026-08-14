import { fetch } from '@tauri-apps/plugin-http'
import { openUrl } from '@tauri-apps/plugin-opener'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_BASE_URL = 'https://auth.openai.com'
const USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`
const VERIFICATION_URL = `${AUTH_BASE_URL}/codex/device`
const REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000
const REFRESH_WINDOW_MS = 5 * 60 * 1000
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

export interface CodexOAuthCredential {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
  accountId: string
}

export interface DeviceLoginInfo {
  userCode: string
  verificationUri: string
}

interface DeviceAuthorization {
  deviceAuthId: string
  userCode: string
  intervalMs: number
}

interface AuthorizationCode {
  authorizationCode: string
  codeVerifier: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function responseError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  return body || response.statusText || `HTTP ${response.status}`
}

async function requestDeviceAuthorization(signal?: AbortSignal): Promise<DeviceAuthorization> {
  const response = await fetch(USER_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal,
  })
  if (!response.ok) {
    throw new Error(`Could not start ChatGPT login: ${await responseError(response)}`)
  }
  const json = await response.json() as Record<string, unknown>
  const interval = Number(json.interval)
  if (typeof json.device_auth_id !== 'string' || typeof json.user_code !== 'string' || !Number.isFinite(interval)) {
    throw new Error('OpenAI returned an invalid device authorization response.')
  }
  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    intervalMs: Math.max(interval, 1) * 1000,
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Login cancelled'))
    const timeout = window.setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timeout)
      reject(new Error('Login cancelled'))
    }, { once: true })
  })
}

function pendingDeviceResponse(status: number, body: string): boolean {
  if (status === 403 || status === 404) return true
  return body.includes('deviceauth_authorization_pending')
}

async function pollOnce(device: DeviceAuthorization, signal?: AbortSignal): Promise<AuthorizationCode | null> {
  const response = await fetch(DEVICE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_auth_id: device.deviceAuthId,
      user_code: device.userCode,
    }),
    signal,
  })
  if (response.ok) {
    const json = await response.json() as Record<string, unknown>
    if (typeof json.authorization_code !== 'string' || typeof json.code_verifier !== 'string') {
      throw new Error('OpenAI returned an invalid authorization code response.')
    }
    return { authorizationCode: json.authorization_code, codeVerifier: json.code_verifier }
  }
  const body = await response.text().catch(() => '')
  if (pendingDeviceResponse(response.status, body)) return null
  if (body.includes('slow_down')) await wait(5_000, signal)
  else throw new Error(`ChatGPT login failed: ${body || response.statusText}`)
  return null
}

async function pollForAuthorization(device: DeviceAuthorization, signal?: AbortSignal): Promise<AuthorizationCode> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  while (Date.now() < deadline) {
    await wait(device.intervalMs, signal)
    const code = await pollOnce(device, signal)
    if (code) return code
  }
  throw new Error('ChatGPT login timed out. Please try again.')
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]
  if (!payload) throw new Error('OpenAI returned an invalid access token.')
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  try {
    return JSON.parse(atob(padded)) as Record<string, unknown>
  } catch (error) {
    throw new Error(`Could not read the OpenAI access token: ${errorMessage(error)}`)
  }
}

function accountIdFromToken(access: string): string {
  const payload = decodeJwtPayload(access)
  const claim = payload[JWT_CLAIM_PATH]
  const accountId = typeof claim === 'object' && claim
    ? (claim as Record<string, unknown>).chatgpt_account_id
    : undefined
  if (typeof accountId !== 'string' || !accountId) {
    throw new Error('OpenAI access token does not contain a ChatGPT account ID.')
  }
  return accountId
}

async function readToken(response: Response, operation: string): Promise<CodexOAuthCredential> {
  if (!response.ok) throw new Error(`OpenAI token ${operation} failed: ${await responseError(response)}`)
  const json = await response.json() as Record<string, unknown>
  if (typeof json.access_token !== 'string' || typeof json.refresh_token !== 'string' || typeof json.expires_in !== 'number') {
    throw new Error(`OpenAI token ${operation} returned an invalid response.`)
  }
  return {
    type: 'oauth',
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: accountIdFromToken(json.access_token),
  }
}

async function exchangeCode(code: AuthorizationCode, signal?: AbortSignal): Promise<CodexOAuthCredential> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: code.authorizationCode,
      code_verifier: code.codeVerifier,
      redirect_uri: REDIRECT_URI,
    }),
    signal,
  })
  return readToken(response, 'exchange')
}

export async function loginWithChatGpt(
  onDeviceCode: (info: DeviceLoginInfo) => void,
  signal?: AbortSignal,
): Promise<CodexOAuthCredential> {
  const device = await requestDeviceAuthorization(signal)
  onDeviceCode({ userCode: device.userCode, verificationUri: VERIFICATION_URL })
  await openUrl(VERIFICATION_URL)
  const code = await pollForAuthorization(device, signal)
  return exchangeCode(code, signal)
}

export async function refreshCodexCredential(
  credential: CodexOAuthCredential,
  signal?: AbortSignal,
): Promise<CodexOAuthCredential> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credential.refresh,
      client_id: CLIENT_ID,
    }),
    signal,
  })
  return readToken(response, 'refresh')
}

export async function validCodexCredential(
  credential: CodexOAuthCredential,
  signal?: AbortSignal,
): Promise<CodexOAuthCredential> {
  if (credential.expires - Date.now() > REFRESH_WINDOW_MS) return credential
  return refreshCodexCredential(credential, signal)
}
