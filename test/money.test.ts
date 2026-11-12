// Coins to cents and back, and the one-time conversion of a ledger that was kept in whole coins.
import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { convertToCents, inCents } from "../src/server/money"
import { defaultConfig, toCents } from "../src/shared/types"

test("amounts typed in coins become whole cents", () => {
  expect(toCents("10")).toBe(1000)
  expect(toCents("0.5")).toBe(50)
  expect(toCents("12.34")).toBe(1234)
  expect(toCents(12.34)).toBe(1234)
  expect(toCents(0.07)).toBe(7)
  expect(toCents(-3)).toBe(-300)
  for (const bad of ["1.234", "abc", "", "1e3", "1,5", " ", null, undefined, Number.NaN, 1 / 3]) expect(toCents(bad)).toBeNull()
})

test("the settings are used in cents and left alone in coins", () => {
  const inside = inCents(defaultConfig)
  expect(inside.starting).toBe(10_000)
  expect(inside.emoji.map((item) => item.amount)).toEqual([100, 500, 1000, 2000])
  expect(inside.games).toEqual({ enabled: false, maxBet: 2500, reserve: 50_000, jail: 15 })
  expect(defaultConfig.starting).toBe(100)
})

test("a ledger in coins is converted once, and nobody's share changes", () => {
  const db = new Database(":memory:")
  db.exec(`
    create table meta (key text primary key, value text not null);
    create table accounts (id text primary key, balance integer not null, received integer not null, given integer not null);
    create table entries (id integer primary key autoincrement, amount integer not null);
    create table reactions (key text primary key, amount integer not null);
    create table duels (id integer primary key autoincrement, amount integer not null);
    insert into accounts values ('UA', 135, 40, 5), ('UB', 80, 0, 20), ('HOUSE', 500, 0, 0);
    insert into entries (amount) values (100), (100), (500), (20), (5);
    insert into reactions values ('k', 5);
    insert into duels (amount) values (20);
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
  const state = () => ({
    accounts: db.query("select * from accounts order by id").all(),
    entries: db.query("select amount from entries order by id").all(),
    reactions: db.query("select amount from reactions").all(),
    duels: db.query("select count(*) as n from duels").get(),
  })

  expect(convertToCents(sql as never)).toBe(true)
  const once = state()
  expect(once).toEqual({
    accounts: [
      { id: "HOUSE", balance: 50_000, received: 0, given: 0 },
      { id: "UA", balance: 13_500, received: 4000, given: 500 },
      { id: "UB", balance: 8000, received: 0, given: 2000 },
    ],
    entries: [{ amount: 10_000 }, { amount: 10_000 }, { amount: 50_000 }, { amount: 2000 }, { amount: 500 }],
    reactions: [{ amount: 500 }],
    duels: { n: 0 },
  })

  // Starting again, as every restart of the Workspace does, must not multiply anything a second time.
  expect(convertToCents(sql as never)).toBe(false)
  expect(state()).toEqual(once)
})
