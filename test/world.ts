// A stand-in for the Workspace's ledger: an in-memory SQLite database with the same tables and the same rule for
// moving coins. It counts in cents, as the real one does. The helpers take and give coins so tests read naturally.
import { Database } from "bun:sqlite"
import { afterEach, beforeEach } from "bun:test"
import { setup } from "../src/server/casino"
import type { Ledger } from "../src/server/ledger"
import { setupMarket } from "../src/server/market"
import { inCents } from "../src/server/money"
import { CENTS, defaultConfig, type Config } from "../src/shared/types"

export const A = "UAAA"
export const B = "UBBB"
const realNow = Date.now
export const clock = { now: Date.UTC(2026, 10, 11, 9) }

/** Freezes the clock for each test in the file that calls it. */
export function frozen() {
  beforeEach(() => {
    clock.now = Date.UTC(2026, 10, 11, 9)
    Date.now = () => clock.now
  })
  afterEach(() => {
    Date.now = realNow
  })
}

export function world(games: Partial<Config["games"]> = {}, market: Partial<Config["market"]> = {}) {
  const db = new Database(":memory:")
  db.exec(`
    create table accounts (id text primary key, name text not null, image text, bot integer not null default 0,
      balance integer not null default 0, received integer not null default 0, given integer not null default 0,
      slack_admin integer not null default 0, created_at integer not null, gone integer not null default 0);
    create table entries (id integer primary key autoincrement, at integer not null, kind text not null, from_id text,
      to_id text, amount integer not null, note text, actor text, link text);
  `)
  const cursor = (rows: unknown[], written: number) => ({ toArray: () => rows, one: () => rows[0], rowsWritten: written })
  const sql = {
    exec(query: string, ...params: unknown[]) {
      if (!params.length && query.split(";").filter((part) => part.trim()).length > 1) {
        db.exec(query)
        return cursor([], 0)
      }
      const statement = db.query(query)
      if (/^\s*select/i.test(query)) return cursor(statement.all(...(params as never[])), 0)
      return cursor([], statement.run(...(params as never[])).changes)
    },
  }
  const config: Config = inCents({
    ...defaultConfig,
    games: { ...defaultConfig.games, enabled: true, ...games },
    market: { ...defaultConfig.market, enabled: true, ...market },
  })
  const posts: Record<string, unknown>[] = []
  const meta = new Map<string, unknown>()
  let alarm: number | null = null
  const row = (id: string) => db.query("select * from accounts where id = ?").get(id) as ReturnType<Ledger["row"]>
  const ledger = {
    sql,
    storage: { getAlarm: async () => alarm, setAlarm: async (at: number) => void (alarm = at) },
    env: { PUBLIC_URL: "https://example.test/bank" },
    config: () => config,
    row,
    ensure: async (ids: string[]) => new Map(ids.map((id) => [id, row(id)])),
    move(input: Parameters<Ledger["move"]>[0]) {
      const from = input.from ? row(input.from) : null
      const to = input.to ? row(input.to) : null
      if ((input.from && !from) || (input.to && !to)) return { ok: false, reason: "unknown", balance: 0 } as const
      if (from && from.balance < input.amount) return { ok: false, reason: "insufficient", balance: from.balance } as const
      if (from) db.query("update accounts set balance = balance - ? where id = ?").run(input.amount, from.id)
      if (to) db.query("update accounts set balance = balance + ? where id = ?").run(input.amount, to.id)
      const id = db
        .query("insert into entries (at, kind, from_id, to_id, amount, note, actor) values (?, ?, ?, ?, ?, ?, ?)")
        .run(clock.now, input.kind, input.from, input.to, input.amount, input.note ?? null, input.actor ?? null).lastInsertRowid
      return { ok: true, id: Number(id), from: null, to: null } as const
    },
    meta: (key: string) => (meta.get(key) ?? null) as never,
    setMeta: (key: string, value: unknown) => void meta.set(key, value),
    call: async (method: string, params: Record<string, unknown> = {}) => (posts.push({ method, ...params }), {} as never),
    admin: () => false,
  } as unknown as Ledger

  setup(sql as never)
  setupMarket(sql as never)
  /** Someone new, with the starting hundred. */
  const join = (id: string) => {
    db.query("insert into accounts (id, name, created_at) values (?, ?, ?)").run(id, id.toLowerCase(), clock.now)
    ledger.move({ from: null, to: id, amount: 100 * CENTS, kind: "grant" })
  }
  for (const id of [A, B]) join(id)
  const print = (to: string, coins: number) => ledger.move({ from: null, to, amount: coins * CENTS, kind: "adjust" })
  const give = (from: string, to: string, coins: number) => ledger.move({ from, to, amount: coins * CENTS, kind: "give" })
  const balance = (id: string) => row(id)!.balance / CENTS
  const total = () => (db.query("select sum(balance) as n from accounts").get() as { n: number }).n / CENTS
  const lowest = () => (db.query("select min(balance) as n from accounts").get() as { n: number }).n / CENTS
  return { db, ledger, config, posts, join, print, give, balance, total, lowest, alarm: () => alarm }
}
