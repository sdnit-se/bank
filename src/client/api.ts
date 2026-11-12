import type { Admin, CasinoStats, Channel, Config, CustomEmoji, Economy, History, Leaderboard, MarketStats, Me, Portfolio, Shop } from "../shared/types"

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

/** Something to put on a shelf, or a change to it. `bank` puts it on the bank's shelf, for admins. */
export type Stocked = { id?: number; bank?: boolean; name: string; about: string; price: number; stock: number | null }

export const api = {
  me: () => request<Me>("GET", "/me"),
  leaderboard: () => request<Leaderboard>("GET", "/leaderboard"),
  economy: () => request<Economy>("GET", "/economy"),
  portfolio: () => request<Portfolio>("GET", "/portfolio"),
  casino: () => request<CasinoStats>("GET", "/casino"),
  market: () => request<MarketStats>("GET", "/market"),
  history: () => request<History>("GET", "/history"),
  people: () => request<Person[]>("GET", "/people"),
  shop: () => request<Shop>("GET", "/shop"),
  stock: (input: Stocked) => request<Shop>("PUT", "/shop", input),
  unstock: (id: number) => request<Shop>("DELETE", "/shop", { id }),
  buy: (id: number) => request<Shop & { message: string }>("POST", "/shop/buy", { id }),
  give: (to: string, amount: number, note: string) => request<{ balance: number }>("POST", "/give", { to, amount, note }),
  allHistory: () => request<History>("GET", "/admin/history"),
  saveConfig: (config: Config) => request<Config>("PUT", "/admin/config", config),
  adjust: (to: string, amount: number, note: string) => request("POST", "/admin/adjust", { to, amount, note }),
  admins: () => request<Admin[]>("GET", "/admin/admins"),
  addAdmin: (id: string) => request("POST", "/admin/admins", { id }),
  removeAdmin: (id: string) => request("DELETE", "/admin/admins", { id }),
  emoji: () => request<CustomEmoji[]>("GET", "/admin/emoji"),
  redact: (id: number) => request("POST", "/admin/redact", { id }),
  stimulus: (amount: number) => request<{ each: number; people: number }>("POST", "/admin/stimulus", { amount }),
  channels: () => request<Channel[]>("GET", "/admin/channels"),
  join: () => request<{ joined: number }>("POST", "/admin/join"),
}
