// Importing the old bank's history must leave every balance alone and make the received and given totals real.
import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { importHistory, MIGRATED } from "../src/server/migrate"
import { defaultConfig, type Entry } from "../src/shared/types"

function bank() {
  const db = new Database(":memory:")
  db.exec(`
    create table accounts (id text primary key, name text not null, balance integer not null default 0,
      received integer not null default 0, given integer not null default 0);
    create table entries (id integer primary key autoincrement, at integer not null, kind text not null, from_id text,
      to_id text, amount integer not null, note text, actor text, link text);
    create table reactions (key text primary key, from_id text not null, to_id text not null, amount integer not null);
  `)
  const sql = {
    exec(query: string, ...params: unknown[]) {
      const statement = db.query(query)
      if (/^\s*select/i.test(query)) {
        const rows = statement.all(...(params as never[]))
        return { toArray: () => rows, one: () => rows[0], rowsWritten: 0 }
      }
      return { toArray: () => [], one: () => undefined, rowsWritten: statement.run(...(params as never[])).changes }
    },
  }
  // As the new bank looked after moving in: a fresh grant each, then one adjustment to match the old balances.
  const entry = (at: number, kind: string, from: string | null, to: string | null, amount: number, note: string | null = null) => {
    db.query("insert into entries (at, kind, from_id, to_id, amount, note) values (?, ?, ?, ?, ?, ?)").run(at, kind, from, to, amount, note)
    if (from) db.query("update accounts set balance = balance - ? where id = ?").run(amount, from)
    if (to) db.query("update accounts set balance = balance + ? where id = ?").run(amount, to)
  }
  for (const id of ["UA", "UB", "UC"]) {
    db.query("insert into accounts (id, name) values (?, ?)").run(id, id.toLowerCase())
    entry(5_000, "grant", null, id, 100, "starting balance")
  }
  entry(5_100, "adjust", null, "UA", 25, MIGRATED)
  entry(5_100, "adjust", "UB", null, 25, MIGRATED)
  const run = (entries: Entry[]) => db.transaction(() => importHistory(sql as never, entries, defaultConfig.emoji))()
  const all = <T>(query: string) => db.query(query).all() as T[]
  return { entry, run, all }
}

const old = (id: number, at: number, kind: Entry["kind"], from: string | null, to: string | null, amount: number, more: Partial<Entry> = {}): Entry => ({
  id,
  at,
  kind,
  from,
  to,
  amount,
  note: null,
  actor: from,
  link: null,
  ...more,
})

/** What the old bank recorded: three grants, a gift, and a reaction on a message. */
const history = [
  old(3, 1_000, "grant", null, "UC", 100),
  old(1, 1_000, "grant", null, "UA", 100),
  old(2, 1_000, "grant", null, "UB", 100),
  old(4, 2_000, "give", "UB", "UA", 20, { note: "for the fix" }),
  old(5, 3_000, "reaction", "UB", "UA", 5, { link: "https://x.slack.com/archives/C0A00GN2F/p1762870000123456?thread_ts=1" }),
]

test("history comes in, balances stay, and the totals become real", () => {
  const b = bank()
  // Something that happened here after moving in has to survive, in order, after the imported entries.
  b.entry(6_000, "give", "UA", "UC", 7, "welcome")
  const before = b.all<{ id: string; balance: number }>("select id, balance from accounts order by id")

  expect(b.run(history)).toEqual({ imported: 5, kept: 1, reactions: 1 })
  expect(b.all("select id, balance from accounts order by id")).toEqual(before)
  expect(b.all("select id, received, given from accounts order by id")).toEqual([
    { id: "UA", received: 25, given: 7 },
    { id: "UB", received: 0, given: 25 },
    { id: "UC", received: 7, given: 0 },
  ])
  expect(b.all<{ id: number; kind: string; at: number }>("select id, kind, at from entries order by id")).toEqual([
    { id: 1, kind: "grant", at: 1_000 },
    { id: 2, kind: "grant", at: 1_000 },
    { id: 3, kind: "grant", at: 1_000 },
    { id: 4, kind: "give", at: 2_000 },
    { id: 5, kind: "reaction", at: 3_000 },
    { id: 6, kind: "give", at: 6_000 },
  ])
  expect(b.all("select * from entries where note = 'migrated from the hosted bank'")).toEqual([])
  expect(b.all("select key from reactions")).toEqual([{ key: "C0A00GN2F:1762870000.123456:UB:coin-5" }])
})

test("a history that doesn't match the balances changes nothing", () => {
  const b = bank()
  const before = b.all("select * from entries order by id")
  const wrong = [...history.slice(0, 4), old(5, 3_000, "reaction", "UB", "UA", 10)]
  expect(() => b.run(wrong)).toThrow("importing would change balances")
  expect(b.all("select * from entries order by id")).toEqual(before)
  expect(b.all("select received from accounts where received != 0")).toEqual([])
})

test("entries about strangers or of unknown kinds are refused", () => {
  const b = bank()
  expect(() => b.run([...history, old(6, 4_000, "give", "UZ", "UA", 1)])).toThrow("no account here: UZ")
  expect(() => b.run([old(1, 1, "bet" as never, "UA", null, 1)])).toThrow("not one this bank understands")
  expect(() => b.run([])).toThrow("no entries")
})
