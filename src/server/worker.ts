import type { Config } from "../shared/types"
import type { Env } from "./env"
import { botScopes, decodeJwt, sign, slack, unsign, verified } from "./slack"
import type { EventEnvelope, Viewer } from "./workspace"

export { Workspace } from "./workspace"

const BASE = "/bank"
const SESSION = "bank_session"
const STATE = "bank_state"

type Session = Viewer & {
  team: { id: string; name: string; domain: string | null; icon: string | null }
  exp: number
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function cookies(request: Request) {
  const result: Record<string, string> = {}
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=")
    if (index > 0) result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return result
}

function cookie(name: string, value: string, maxAge: number) {
  return `${name}=${encodeURIComponent(value)}; Path=${BASE}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`
}

function redirect(location: string, headers: Record<string, string | string[]> = {}) {
  const result = new Headers({ location })
  for (const [key, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) result.append(key, item)
  }
  return new Response(null, { status: 302, headers: result })
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}

function workspace(env: Env, team: string) {
  return env.WORKSPACES.get(env.WORKSPACES.idFromName(team))
}

async function session(request: Request, env: Env) {
  const value = await unsign<Session>(env.SESSION_SECRET, cookies(request)[SESSION])
  if (!value || value.exp < Date.now()) return null
  return value
}

async function startSession(env: Env, value: Omit<Session, "exp">) {
  const maxAge = 30 * 24 * 60 * 60
  const token = await sign(env.SESSION_SECRET, { ...value, exp: Date.now() + maxAge * 1000 } satisfies Session)
  return cookie(SESSION, token, maxAge)
}

async function newState(env: Env, kind: "install" | "login") {
  const nonce = crypto.randomUUID()
  return { nonce, cookie: cookie(STATE, await sign(env.SESSION_SECRET, { nonce, kind }), 600) }
}

async function checkState(request: Request, env: Env, kind: "install" | "login", state: string | null) {
  const value = await unsign<{ nonce: string; kind: string }>(env.SESSION_SECRET, cookies(request)[STATE])
  return Boolean(value && state && value.nonce === state && value.kind === kind)
}

// ---------- Slack OAuth: install and sign in

async function install(request: Request, env: Env) {
  const state = await newState(env, "install")
  const url = new URL("https://slack.com/oauth/v2/authorize")
  url.searchParams.set("client_id", env.SLACK_CLIENT_ID)
  url.searchParams.set("scope", botScopes.join(","))
  url.searchParams.set("redirect_uri", `${env.PUBLIC_URL}/auth/install`)
  url.searchParams.set("state", state.nonce)
  void request
  return redirect(url.toString(), { "set-cookie": state.cookie })
}

async function installCallback(request: Request, env: Env, url: URL) {
  if (url.searchParams.get("error")) return redirect(`${BASE}/?error=${url.searchParams.get("error")}`)
  if (!(await checkState(request, env, "install", url.searchParams.get("state")))) {
    return redirect(`${BASE}/?error=state`)
  }
  const result = await slack<{
    access_token: string
    bot_user_id: string
    app_id: string
    team: { id: string; name: string } | null
    enterprise: { id: string } | null
    authed_user: { id: string }
  }>("oauth.v2.access", null, {
    client_id: env.SLACK_CLIENT_ID,
    client_secret: env.SLACK_CLIENT_SECRET,
    code: url.searchParams.get("code"),
    redirect_uri: `${env.PUBLIC_URL}/auth/install`,
  })
  if (!result.team) return redirect(`${BASE}/?error=org_install`)
  const info = await slack<{ team: { domain?: string; icon?: { image_132?: string } } }>("team.info", result.access_token)
    .then((info) => info.team)
    .catch(() => null)
  const team = {
    id: result.team.id,
    name: result.team.name,
    domain: info?.domain ?? null,
    icon: info?.icon?.image_132 ?? null,
  }
  const viewer = await workspace(env, team.id).installed({
    token: result.access_token,
    botUserId: result.bot_user_id,
    appId: result.app_id,
    teamId: team.id,
    teamName: team.name,
    domain: team.domain,
    icon: team.icon,
    installer: result.authed_user.id,
  })
  return redirect(`${BASE}/?installed=1`, {
    "set-cookie": [await startSession(env, { ...viewer, team }), cookie(STATE, "", 0)],
  })
}

async function login(request: Request, env: Env, url: URL) {
  const state = await newState(env, "login")
  const target = new URL("https://slack.com/openid/connect/authorize")
  target.searchParams.set("response_type", "code")
  target.searchParams.set("scope", "openid profile")
  target.searchParams.set("client_id", env.SLACK_CLIENT_ID)
  target.searchParams.set("redirect_uri", `${env.PUBLIC_URL}/auth/login`)
  target.searchParams.set("state", state.nonce)
  target.searchParams.set("nonce", state.nonce)
  const team = url.searchParams.get("team")
  if (team) target.searchParams.set("team", team)
  void request
  return redirect(target.toString(), { "set-cookie": state.cookie })
}

async function loginCallback(request: Request, env: Env, url: URL) {
  if (url.searchParams.get("error")) return redirect(`${BASE}/?error=${url.searchParams.get("error")}`)
  if (!(await checkState(request, env, "login", url.searchParams.get("state")))) {
    return redirect(`${BASE}/?error=state`)
  }
  // The id token comes straight from Slack over TLS in exchange for our client secret, so its claims are trusted as is.
  const result = await slack<{ id_token: string }>("openid.connect.token", null, {
    client_id: env.SLACK_CLIENT_ID,
    client_secret: env.SLACK_CLIENT_SECRET,
    code: url.searchParams.get("code"),
    redirect_uri: `${env.PUBLIC_URL}/auth/login`,
  })
  const claims = decodeJwt<Record<string, string | undefined>>(result.id_token)
  const user = claims["https://slack.com/user_id"]
  const teamId = claims["https://slack.com/team_id"]
  if (!user || !teamId) return redirect(`${BASE}/?error=claims`)
  const viewer: Viewer = { id: user, name: claims.name ?? claims.given_name ?? "you", image: claims.picture ?? null }
  const team = {
    id: teamId,
    name: claims["https://slack.com/team_name"] ?? "your workspace",
    domain: claims["https://slack.com/team_domain"] ?? null,
    icon: claims["https://slack.com/team_image_132"] ?? claims["https://slack.com/team_image_88"] ?? null,
  }
  await workspace(env, teamId).login(viewer)
  return redirect(`${BASE}/`, { "set-cookie": [await startSession(env, { ...viewer, team }), cookie(STATE, "", 0)] })
}

// ---------- Slack: commands and events

async function command(request: Request, env: Env, ctx: ExecutionContext) {
  const body = await verified(request, env.SLACK_SIGNING_SECRET)
  if (body === null) return new Response("bad signature", { status: 401 })
  const params = Object.fromEntries(new URLSearchParams(body))
  const team = params.team_id
  if (!team || !params.user_id) return new Response("bad request", { status: 400 })
  void ctx
  const message = await workspace(env, team).command({
    text: params.text ?? "",
    user_id: params.user_id,
    // A signed request can be replayed within Slack's five-minute window; the signature identifies it.
    request: request.headers.get("x-slack-signature") ?? "",
  })
  return json(message)
}

async function events(request: Request, env: Env, ctx: ExecutionContext) {
  const body = await verified(request, env.SLACK_SIGNING_SECRET)
  if (body === null) return new Response("bad signature", { status: 401 })
  const payload = JSON.parse(body) as { type: string; challenge?: string; team_id?: string } & EventEnvelope
  if (payload.type === "url_verification") return json({ challenge: payload.challenge })
  if (payload.type === "event_callback" && payload.team_id) {
    ctx.waitUntil(
      workspace(env, payload.team_id)
        .event({ event_id: payload.event_id, event: payload.event })
        .catch((error: unknown) => console.error("event failed", error)),
    )
  }
  return new Response(null, { status: 200 })
}

// ---------- JSON API for the web app

async function api(request: Request, env: Env, path: string) {
  const viewer = await session(request, env)
  if (!viewer) throw new HttpError(401, "signed out")
  if (request.method !== "GET" && request.headers.get("origin") !== new URL(env.PUBLIC_URL).origin) {
    throw new HttpError(403, "bad origin")
  }
  const ws = workspace(env, viewer.team.id)
  const user: Viewer = { id: viewer.id, name: viewer.name, image: viewer.image }
  const body = async <T>() => (await request.json()) as T
  const route = `${request.method} ${path}`

  // The app's operator (dax in Anomaly) can look up installs by Durable Object id, as listed by `cf durable-objects`.
  if (route === "GET /operator/workspaces") {
    if (viewer.id !== "U065BMCVB8F" || viewer.team.id !== "T0HJ2SVJ4") throw new HttpError(404, "not found")
    const ids = (new URL(request.url).searchParams.get("ids") ?? "").split(",").filter((id) => /^[0-9a-f]{64}$/.test(id))
    return Promise.all(ids.map(async (id) => ({ id, ...(await env.WORKSPACES.get(env.WORKSPACES.idFromString(id)).summary()) })))
  }
  if (route === "POST /operator/reconcile") {
    if (viewer.id !== "U065BMCVB8F" || viewer.team.id !== "T0HJ2SVJ4") throw new HttpError(404, "not found")
    const input = await body<{ ids: string[]; apply?: boolean }>()
    const ids = (input.ids ?? []).filter((id) => /^[0-9a-f]{64}$/.test(id))
    return Promise.all(
      ids.map(async (id) => ({ id, ...(await env.WORKSPACES.get(env.WORKSPACES.idFromString(id)).reconcile(Boolean(input.apply))) })),
    )
  }
  if (route === "GET /me") return ws.me(user, viewer.team)
  if (route === "GET /leaderboard") return ws.leaderboard()
  if (route === "GET /history") return ws.history(user, "mine")
  if (route === "GET /people") return ws.people(user)
  if (route === "POST /give") {
    const input = await body<{ to: string; amount: number; note?: string }>()
    return ws.give(user, input.to, Number(input.amount), input.note?.trim() || null)
  }
  if (route === "GET /admin/history") return ws.history(user, "all", 500)
  if (route === "PUT /admin/config") return ws.saveConfig(user, await body<Config>())
  if (route === "POST /admin/adjust") {
    const input = await body<{ to: string; amount: number; note?: string }>()
    return ws.adjust(user, input.to, Number(input.amount), input.note?.trim() || null)
  }
  if (route === "POST /admin/redact") return ws.redact(user, Number((await body<{ id: number }>()).id))
  if (route === "GET /admin/admins") return ws.admins(user)
  if (route === "POST /admin/admins") return ws.addAdmin(user, (await body<{ id: string }>()).id).then(() => ({ ok: true }))
  if (route === "DELETE /admin/admins") {
    return ws.removeAdmin(user, (await body<{ id: string }>()).id).then(() => ({ ok: true }))
  }
  if (route === "GET /admin/emoji") return ws.customEmoji(user)
  if (route === "POST /admin/join") return ws.joinChannels(user)
  if (route === "POST /admin/sync") return ws.resyncMembers(user)
  throw new HttpError(404, "not found")
}

// ---------- static app

// Assets are stored at the root of the build; the app is served under BASE.
async function asset(request: Request, env: Env, path: string) {
  const url = new URL(request.url)
  url.pathname = path || "/"
  if (/\.[a-z0-9]+$/i.test(path)) {
    const response = await env.ASSETS.fetch(new Request(url, request))
    const headers = new Headers(response.headers)
    if (path.startsWith("/assets/")) headers.set("cache-control", "public, max-age=31536000, immutable")
    return new Response(response.body, { status: response.status, headers })
  }
  url.pathname = "/index.html"
  const html = await env.ASSETS.fetch(new Request(url, { headers: request.headers }))
  return new Response(html.body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  })
}

function secure(response: Response) {
  const headers = new Headers(response.headers)
  headers.set("x-content-type-options", "nosniff")
  headers.set("x-frame-options", "DENY")
  headers.set("content-security-policy", "frame-ancestors 'none'")
  headers.set("referrer-policy", "same-origin")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export default {
  async fetch(request, env, ctx) {
    return secure(await handle(request, env, ctx))
  },
} satisfies ExportedHandler<Env>

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  {
    const url = new URL(request.url)
    if (url.pathname === BASE) return redirect(`${BASE}/${url.search}`)
    const path = url.pathname.slice(BASE.length)
    try {
      if (path === "/install") return await install(request, env)
      if (path === "/auth/install") return await installCallback(request, env, url)
      if (path === "/login") return await login(request, env, url)
      if (path === "/auth/login") return await loginCallback(request, env, url)
      if (path === "/logout") return redirect(`${BASE}/`, { "set-cookie": cookie(SESSION, "", 0) })
      if (path === "/slack/commands" && request.method === "POST") return await command(request, env, ctx)
      if (path === "/slack/events" && request.method === "POST") return await events(request, env, ctx)
      if (path.startsWith("/api/")) return json(await api(request, env, path.slice(4)))
      return await asset(request, env, path)
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status)
      const message = error instanceof Error ? error.message : String(error)
      console.error("request failed", path, error)
      if (path.startsWith("/api/")) return json({ error: message.replace(/^Error: /, "") }, message === "forbidden" ? 403 : 400)
      return redirect(`${BASE}/?error=failed`)
    }
  }
}
