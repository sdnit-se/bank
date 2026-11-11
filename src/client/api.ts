import type { Admin, Config, CustomEmoji, History, Leaderboard, Me } from "../shared/types"

export const BASE = "/bank"

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await response.json().catch(() => ({}))) as { error?: string }
  if (!response.ok) throw new ApiError(response.status, data.error ?? `request failed (${response.status})`)
  return data as T
}

export type Person = { id: string; name: string; image: string | null }

export const api = {
  me: () => request<Me>("GET", "/me"),
  leaderboard: () => request<Leaderboard>("GET", "/leaderboard"),
  history: () => request<History>("GET", "/history"),
  people: () => request<Person[]>("GET", "/people"),
  give: (to: string, amount: number, note: string) => request<{ balance: number }>("POST", "/give", { to, amount, note }),
  allHistory: () => request<History>("GET", "/admin/history"),
  saveConfig: (config: Config) => request<Config>("PUT", "/admin/config", config),
  adjust: (to: string, amount: number, note: string) => request("POST", "/admin/adjust", { to, amount, note }),
  admins: () => request<Admin[]>("GET", "/admin/admins"),
  addAdmin: (id: string) => request("POST", "/admin/admins", { id }),
  removeAdmin: (id: string) => request("DELETE", "/admin/admins", { id }),
  emoji: () => request<CustomEmoji[]>("GET", "/admin/emoji"),
  redact: (id: number) => request("POST", "/admin/redact", { id }),
  join: () => request<{ joined: number }>("POST", "/admin/join"),
}
