export const botScopes = [
  "commands",
  "chat:write",
  "im:write",
  "reactions:read",
  "users:read",
  "emoji:read",
  "team:read",
  "channels:read",
  "channels:join",
  "canvases:write",
]

export class SlackError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`slack ${method}: ${code}`)
  }
}

export async function slack<T = Record<string, unknown>>(
  method: string,
  token: string | null,
  params: Record<string, unknown> = {},
): Promise<T> {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    body.set(key, typeof value === "string" ? value : JSON.stringify(value))
  }
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`https://slack.com/api/${method}`, { method: "POST", headers, body })
  const json = (await response.json()) as { ok: boolean; error?: string } & T
  if (!json.ok) throw new SlackError(method, json.error ?? `http_${response.status}`)
  return json
}

const encoder = new TextEncoder()

async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)))
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function equal(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Reads the body of a request from Slack, or returns null when its signature doesn't check out. */
export async function verified(request: Request, secret: string) {
  const timestamp = request.headers.get("x-slack-request-timestamp")
  const signature = request.headers.get("x-slack-signature")
  if (!timestamp || !signature) return null
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return null
  // Slack's payloads are a few KB; refuse to buffer anything big before the signature is checked.
  if (Number(request.headers.get("content-length") ?? 0) > 64 * 1024) return null
  const body = await request.text()
  if (body.length > 64 * 1024) return null
  const expected = "v0=" + hex(await hmac(secret, `v0:${timestamp}:${body}`))
  return equal(expected, signature) ? body : null
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function unbase64url(text: string) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4)
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}

export async function sign(secret: string, value: unknown) {
  const payload = base64url(encoder.encode(JSON.stringify(value)))
  return `${payload}.${base64url(await hmac(secret, payload))}`
}

export async function unsign<T>(secret: string, token: string | undefined): Promise<T | null> {
  if (!token) return null
  const [payload, mac] = token.split(".")
  if (!payload || !mac) return null
  if (!equal(base64url(await hmac(secret, payload)), mac)) return null
  return JSON.parse(new TextDecoder().decode(unbase64url(payload))) as T
}

export function decodeJwt<T>(token: string): T {
  const part = token.split(".")[1]
  if (!part) throw new Error("bad id token")
  return JSON.parse(new TextDecoder().decode(unbase64url(part))) as T
}
