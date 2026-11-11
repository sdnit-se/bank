// Taxes and the stimulus, against the stand-in ledger. Every coin taxed has to arrive at the central bank, and a
// rate of zero has to take nothing.
import { afterEach, expect, test } from "bun:test"
import { play, settle } from "../src/server/casino"
import { market } from "../src/server/market"
import { collectWealth, levy, payInterest, stimulus } from "../src/server/taxes"
import { CENTRAL, CENTS, HOUSE, nextDraw, POT } from "../src/shared/types"
import { A, B, clock, frozen, world } from "./world"

frozen()
const realFetch = globalThis.fetch
afterEach(() => void (globalThis.fetch = realFetch))
const DAY = 24 * 60 * 60 * 1000

/** A world with these tax rates, in percent. */
function taxing(taxes: { transfer?: number; winnings?: number; wealth?: number; wealthAbove?: number }) {
  const w = world()
  Object.assign(w.config.taxes, { ...taxes, ...(taxes.wealthAbove === undefined ? {} : { wealthAbove: taxes.wealthAbove * CENTS }) })
  return w
}

test("a levy takes its share for the central bank, and nothing at a rate of zero", () => {
  const w = taxing({})
  expect(levy(w.ledger, { from: A, amount: 10 * CENTS, rate: 0, note: "transfer tax" })).toBe(0)
  expect(levy(w.ledger, { from: A, amount: -5 * CENTS, rate: 10, note: "winnings tax" })).toBe(0)
  expect(levy(w.ledger, { from: A, amount: 10 * CENTS, rate: 5, note: "transfer tax" })).toBe(50)
  // A third of a cent rounds away.
  expect(levy(w.ledger, { from: A, amount: 3, rate: 10, note: "transfer tax" })).toBe(0)
  expect([w.balance(A), w.balance(CENTRAL)]).toEqual([99.5, 0.5])
  expect(w.total()).toBe(200)
})

test("a casino win is taxed on its profit only, and a loss not at all", async () => {
  const w = taxing({ winnings: 10 })
  w.print(HOUSE, 500)
  let [wins, losses] = [0, 0]
  for (let round = 0; round < 60; round++) {
    clock.now += 7_000
    const before = w.balance(A)
    const reply = await play(w.ledger, { sub: "flip", words: ["2"], user: A, channel: "C1" })
    const change = Math.round((w.balance(A) - before) * 100) / 100
    // Lose the stake of 2, or win 2 and pay 10% of that.
    expect([-2, 1.8]).toContain(change)
    expect(reply!.text.includes("the taxman took 0.20 coins")).toBe(change > 0)
    change > 0 ? wins++ : losses++
  }
  expect(wins).toBeGreaterThan(0)
  expect(losses).toBeGreaterThan(0)
  expect(w.balance(CENTRAL)).toBeCloseTo(wins * 0.2)
  expect(w.total()).toBe(700)
})

test("a lottery winner is taxed on the pot less their own tickets", async () => {
  const w = taxing({ winnings: 10 })
  await play(w.ledger, { sub: "lottery", words: ["20"], user: A, channel: "C1" })
  await settle(w.ledger)
  // A was the only player: the pot of 20 was all their own money, so there is nothing to tax.
  expect([w.balance(A), w.balance(CENTRAL), w.balance(POT)]).toEqual([100, 0, 0])

  await play(w.ledger, { sub: "lottery", words: ["10"], user: A, channel: "C1" })
  w.print(POT, 30)
  await settle(w.ledger)
  // Now the pot is 40 against 10 of their own: 30 of winnings, 3 of it tax.
  expect([w.balance(A), w.balance(CENTRAL)]).toEqual([127, 3])
  expect(String(w.posts.at(-1)!.text)).toContain("the taxman took 3 coins")
})

test("a market gain is taxed, a market loss is not", async () => {
  const feed = (price: number) => {
    globalThis.fetch = (async (url: string) =>
      new Response(
        JSON.stringify({
          chart: { result: [{ meta: { symbol: "ERIC-B.ST", currency: "SEK", longName: "Ericsson", regularMarketPrice: price, regularMarketTime: clock.now / 1000 - 30, currentTradingPeriod: { regular: { start: clock.now / 1000 - 7200, end: clock.now / 1000 + 7200 } } } }] },
        }),
      )) as never
  }
  const w = taxing({ winnings: 10 })
  const say = (user: string, text: string) => market(w.ledger, { sub: text.split(" ")[0]!, words: text.split(" ").slice(1), user })
  feed(100)
  await say(A, "buy ERIC-B.ST 50")
  await say(B, "buy ERIC-B.ST 50")
  clock.now += 61_000
  feed(120)
  const up = await say(A, "sell ERIC-B.ST all")
  // 49.50 became 59.40: a gain of 9.90, taxed 0.99, on top of the 0.59 trading fee.
  expect(up!.text).toContain("the taxman took 0.99 coins")
  expect(w.balance(A)).toBe(107.82)
  clock.now += 61_000
  feed(80)
  const down = await say(B, "sell ERIC-B.ST all")
  expect(down!.text).not.toContain("taxman")
  expect(w.balance(B)).toBe(89.2)
  expect(w.balance(CENTRAL)).toBe(0.5 + 0.5 + 0.59 + 0.99 + 0.4)
})

test("the wealth tax is weekly, starts a week after it is switched on, and spares anyone under the threshold", async () => {
  const w = taxing({ wealth: 10, wealthAbove: 200 })
  w.print(A, 150)
  expect(collectWealth(w.ledger)).toBeNull()
  clock.now += 6 * DAY
  expect(collectWealth(w.ledger)).toBeNull()
  clock.now += 2 * DAY
  // A holds 250: 50 above the line, 5 of it tax. B holds 100 and pays nothing.
  expect(collectWealth(w.ledger)).toEqual({ collected: 5 * CENTS, payers: 1 })
  expect([w.balance(A), w.balance(B), w.balance(CENTRAL)]).toEqual([245, 100, 5])
  expect(collectWealth(w.ledger)).toBeNull()

  // The daily round collects it too, announces it, and comes back the next day by itself.
  clock.now += 8 * DAY
  w.ledger.setMeta("lottery_channel", "C7")
  await settle(w.ledger)
  expect(w.balance(A)).toBe(240.5)
  expect(w.posts.at(-1)).toMatchObject({ channel: "C7" })
  expect(String(w.posts.at(-1)!.text)).toContain("4.50 coins")
  expect(w.alarm()).toBe(nextDraw(clock.now))
  expect(w.total()).toBe(350)
})

test("a stimulus splits the central bank's reserves equally, and only what it holds", () => {
  const w = taxing({})
  expect(() => stimulus(w.ledger, 50 * CENTS, A)).toThrow("the central bank only holds 0 coins")
  w.print(CENTRAL, 50.01)
  expect(stimulus(w.ledger, 50.01 * CENTS, A)).toEqual({ each: 2500, people: 2 })
  // The odd cent stays behind.
  expect([w.balance(A), w.balance(B), w.balance(CENTRAL)]).toEqual([125, 125, 0.01])
  expect(() => stimulus(w.ledger, 1, A)).toThrow("less than a cent each")
})

test("interest is paid weekly from the central bank's reserves, and shared out when they fall short", () => {
  const w = taxing({ interest: 10 })
  w.print(A, 100)
  w.print(CENTRAL, 40)
  expect(payInterest(w.ledger)).toBeNull()
  clock.now += 8 * DAY
  // A holds 200 and B 100, so 20 and 10 are due and the reserves cover it.
  expect(payInterest(w.ledger)).toEqual({ paid: 30 * CENTS, people: 2 })
  expect([w.balance(A), w.balance(B), w.balance(CENTRAL)]).toEqual([220, 110, 10])
  clock.now += 8 * DAY
  // Now 22 and 11 are due against 10 in reserve: everyone gets the same fraction, and nothing is printed.
  expect(payInterest(w.ledger)).toEqual({ paid: 999, people: 2 })
  expect([w.balance(A), w.balance(B), w.balance(CENTRAL)]).toEqual([226.66, 113.33, 0.01])
  expect(w.total()).toBe(340)
})
