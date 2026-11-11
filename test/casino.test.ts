// Plays the casino against a stand-in ledger: an in-memory SQLite database with the same tables and the same rule
// for moving coins as the Workspace. What matters most here is that no game creates or destroys a coin.
import { Database } from "bun:sqlite"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { economy, play, settle, setup, type Ledger } from "../src/server/casino"
import { nextDraw } from "../src/server/games"
import { CENTRAL, defaultConfig, HOUSE, POT, type Config } from "../src/shared/types"

const A = "UAAA"
const B = "UBBB"
const realNow = Date.now
let now = Date.UTC(2026, 10, 11, 9)

beforeEach(() => {
  now = Date.UTC(2026, 10, 11, 9)
  Date.now = () => now
})
afterEach(() => {
  Date.now = realNow
})

function world(games: Partial<Config["games"]> = {}) {
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
  const config: Config = { ...defaultConfig, games: { ...defaultConfig.games, enabled: true, ...games } }
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
        .run(now, input.kind, input.from, input.to, input.amount, input.note ?? null, input.actor ?? null).lastInsertRowid
      return { ok: true, id: Number(id), from: null, to: null } as const
    },
    meta: (key: string) => (meta.get(key) ?? null) as never,
    setMeta: (key: string, value: unknown) => void meta.set(key, value),
    call: async (method: string, params: Record<string, unknown> = {}) => (posts.push({ method, ...params }), {} as never),
  } as unknown as Ledger

  setup(sql as never)
  for (const id of [A, B]) {
    db.query("insert into accounts (id, name, created_at) values (?, ?, ?)").run(id, id.toLowerCase(), now)
    ledger.move({ from: null, to: id, amount: 100, kind: "grant" })
  }
  const print = (to: string, amount: number) => ledger.move({ from: null, to, amount, kind: "adjust" })
  const balance = (id: string) => row(id)!.balance
  const total = () => (db.query("select sum(balance) as n from accounts").get() as { n: number }).n
  const lowest = () => (db.query("select min(balance) as n from accounts").get() as { n: number }).n
  const say = (user: string, text: string, channel: string | null = "C1") => {
    const words = text.split(" ")
    return play(ledger, { sub: words[0]!, words: words.slice(1), user, channel })
  }
  return { ledger, config, posts, print, balance, total, lowest, say, alarm: () => alarm }
}

test("the casino is closed unless an admin opens it, and leaves other commands alone", async () => {
  const closed = world({ enabled: false })
  expect((await closed.say(A, "flip 10"))!.text).toContain("the casino is closed")
  expect(await closed.say(A, "give <@UBBB> 10")).toBeNull()
  expect(closed.balance(A)).toBe(100)
})

test("the house only takes a bet it could pay in full", async () => {
  const w = world()
  expect((await w.say(A, "flip 10"))!.text).toContain("the house is broke")
  w.print(HOUSE, 100)
  // Slots can pay 20 times the stake, so 100 covers a stake of 5 and no more.
  const refused = await w.say(A, "slots 25")
  expect(refused!.response_type).toBe("ephemeral")
  expect(refused!.text).toContain("the most it will take on this is 5 coins")
  expect((await w.say(A, "slots 5"))!.response_type).toBe("in_channel")
})

test("bets respect the limit, the player's balance and the pace", async () => {
  const w = world()
  w.print(HOUSE, 500)
  expect((await w.say(A, "flip 26"))!.text).toContain("the limit is 25 coins")
  expect((await w.say(A, "flip"))!.text).toContain("say how much")
  w.ledger.move({ from: A, to: B, amount: 97, kind: "give" })
  const broke = await w.say(A, "flip 10")
  expect(broke!.response_type).toBe("ephemeral")
  expect(broke!.text).toContain("3 coins")
  for (let bet = 0; bet < 10; bet++) expect((await w.say(B, "flip 1"))!.response_type).toBe("in_channel")
  expect((await w.say(B, "flip 1"))!.text).toContain("slow down")
  now += 61_000
  expect((await w.say(B, "flip 1"))!.response_type).toBe("in_channel")
})

test("no amount of gambling creates or destroys a coin", async () => {
  const w = world()
  w.print(HOUSE, 500)
  const before = w.total()
  for (let round = 0; round < 400; round++) {
    now += 7_000
    const user = round % 2 ? A : B
    await w.say(user, round % 3 ? "slots 5" : "flip 5 tails")
    expect(w.total()).toBe(before)
    expect(w.lowest()).toBeGreaterThanOrEqual(0)
  }
  await settle(w.ledger)
  expect(w.total()).toBe(before)
  expect(w.balance(HOUSE)).toBeLessThanOrEqual(w.config.games.reserve)
})

test("a duel moves the stake from the loser to the winner, once", async () => {
  const w = world()
  expect((await w.say(A, "duel <@UAAA> 20"))!.text).toContain("can't duel yourself")
  expect((await w.say(B, "accept"))!.text).toContain("nobody has challenged you")
  const open = await w.say(A, "duel <@UBBB> 20")
  expect(open!.response_type).toBe("in_channel")
  expect(open!.text).toContain("<@UAAA>")
  expect((await w.say(B, "accept"))!.response_type).toBe("in_channel")
  expect([w.balance(A), w.balance(B)].sort()).toEqual([120, 80])
  expect((await w.say(B, "accept"))!.text).toContain("nobody has challenged you")

  await w.say(A, "duel <@UBBB> 10")
  expect((await w.say(B, "decline"))!.response_type).toBe("in_channel")
  await w.say(A, "duel <@UBBB> 10")
  now += 11 * 60_000
  expect((await w.say(B, "accept"))!.text).toContain("nobody has challenged you")
  expect(w.total()).toBe(200)
})

test("the draw settles the house, tops up the pot from the central bank and pays one winner", async () => {
  const w = world()
  w.print(HOUSE, 620)
  w.print(CENTRAL, 100)
  const before = w.total()
  await w.say(A, "lottery 5", "C9")
  await w.say(B, "lottery 15", "C9")
  expect(w.balance(POT)).toBe(20)
  expect(w.alarm()).toBe(nextDraw(now))

  await settle(w.ledger)
  // The house keeps 500 and hands over 120, and the central bank puts a tenth of its 220 into the pot.
  expect(w.balance(HOUSE)).toBe(500)
  expect(w.balance(CENTRAL)).toBe(198)
  expect(w.balance(POT)).toBe(0)
  expect([w.balance(A), w.balance(B)].sort((a, b) => a - b)).toContainEqual(expect.any(Number))
  expect(w.balance(A) + w.balance(B)).toBe(200 - 20 + 42)
  expect(w.total()).toBe(before)
  expect(w.posts).toHaveLength(1)
  expect(w.posts[0]).toMatchObject({ method: "chat.postMessage", channel: "C9" })
  expect(String(w.posts[0]!.text)).toContain("42 coins")

  // With no tickets left there is nothing to draw, and nothing is announced.
  await settle(w.ledger)
  expect(w.posts).toHaveLength(1)
})

test("the central bank refills a house that lost", async () => {
  const w = world()
  w.print(HOUSE, 300)
  w.print(CENTRAL, 1_000)
  await settle(w.ledger)
  expect(w.balance(HOUSE)).toBe(500)
  expect(w.balance(CENTRAL)).toBe(800)
})

test("the economy adds up", async () => {
  const w = world()
  w.print(HOUSE, 500)
  w.ledger.move({ from: A, to: B, amount: 30, kind: "give" })
  await w.say(A, "lottery 10")
  const figures = economy(w.ledger)
  expect(figures.supply).toEqual({ people: 190, house: 500, pot: 10, central: 0, total: 700 })
  expect(figures.supply.total).toBe(w.total())
  expect(figures.days).toHaveLength(30)
  expect(figures.days[29]).toEqual({ day: "2026-11-11", supply: 700, gifts: 30, bets: 10 })
  expect(figures.growth).toEqual({ week: 700, month: 700 })
  expect(figures.gdp.week).toBe(30)
  expect(figures.turnover.week).toBe(10)
  expect(figures.members).toBe(2)
  expect(figures.richestShare).toBeCloseTo(130 / 190)
  expect(figures.broke).toBe(0)
})
