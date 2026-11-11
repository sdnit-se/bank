// The stock market against canned prices and the stand-in ledger in world.ts. No network.
// What matters most: a sale pays today's price, losses pay for gains before anything is printed, and the only coins
// ever created are the shortfall on a profitable sale.
import { afterEach, expect, test } from "bun:test"
import { casinoHelp } from "../src/server/casino"
import { fetchQuote, market, marketHelp, portfolio, quote, tradeLine } from "../src/server/market"
import { CENTRAL, MARKET } from "../src/shared/types"
import { A, B, clock, frozen, world as bare } from "./world"

frozen()
const realFetch = globalThis.fetch
afterEach(() => void (globalThis.fetch = realFetch))

/** Makes the feed answer with this price for every symbol, traded `ago` seconds back on an open or closed exchange. */
function feed(price: number | null, { open = true, ago = 30, name = "Telefonaktiebolaget LM Ericsson (publ)" } = {}) {
  const calls: string[] = []
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url))
    if (price === null) return new Response("{}", { status: 404 })
    const now = clock.now / 1000
    const symbol = decodeURIComponent(String(url).split("/chart/")[1]!.split("?")[0]!)
    const session = open ? { start: now - 7200, end: now + 7200 } : { start: now - 9000, end: now - 1800 }
    return new Response(
      JSON.stringify({
        chart: {
          result: [
            {
              meta: {
                symbol,
                currency: "SEK",
                longName: name,
                fullExchangeName: "Stockholm",
                regularMarketPrice: price,
                regularMarketTime: now - ago,
                currentTradingPeriod: { regular: session },
              },
            },
          ],
        },
      }),
    )
  }) as never
  return calls
}

function world(...options: Parameters<typeof bare>) {
  const w = bare(...options)
  const say = (user: string, text: string) => {
    const words = text.split(" ")
    return market(w.ledger, { sub: words[0]!, words: words.slice(1), user })
  }
  const position = (user: string, symbol: string) =>
    w.db.query("select units, cost from positions where user_id = ? and symbol = ?").get(user, symbol) as { units: number; cost: number } | null
  /** Prices are reused for a minute, so a new one needs the clock to move on. */
  const later = (price: number | null, options?: Parameters<typeof feed>[1]) => {
    clock.now += 61_000
    return feed(price, options)
  }
  /** Every coin ever created, less every coin destroyed, which the balances have to add up to. */
  const created = () =>
    (w.db.query("select coalesce(sum(case when from_id is null then amount when to_id is null then -amount else 0 end), 0) as n from entries").get() as { n: number }).n / 100
  return { ...w, say, position, later, created }
}

test("a quote carries the price, its currency, its age and whether the market is open", async () => {
  feed(106.4)
  expect(await fetchQuote("ERIC-B.ST", clock.now)).toEqual({
    symbol: "ERIC-B.ST",
    name: "Telefonaktiebolaget LM Ericsson (publ)",
    price: 106.4,
    currency: "SEK",
    exchange: "Stockholm",
    at: clock.now - 30_000,
    open: true,
  })
  feed(106.4, { open: false })
  expect((await fetchQuote("ERIC-B.ST", clock.now))!.open).toBe(false)
})

test("anything odd from the feed is no quote at all", async () => {
  feed(null)
  expect(await fetchQuote("NOPE")).toBeNull()
  feed(0)
  expect(await fetchQuote("ERIC-B.ST")).toBeNull()
  globalThis.fetch = (async () => new Response("<html>blocked</html>", { status: 429 })) as never
  expect(await fetchQuote("ERIC-B.ST")).toBeNull()
  globalThis.fetch = (async () => Promise.reject(new Error("down"))) as never
  expect(await fetchQuote("ERIC-B.ST")).toBeNull()
})

test("quotes are reused for a minute, and symbols that aren't symbols never reach the feed", async () => {
  const w = world()
  const calls = feed(106.4)
  expect((await quote(w.ledger, "eric-b.st"))!.price).toBe(106.4)
  expect((await quote(w.ledger, "ERIC-B.ST"))!.price).toBe(106.4)
  expect(calls).toHaveLength(1)
  expect(await quote(w.ledger, "../../etc/passwd")).toBeNull()
  expect(await quote(w.ledger, "A B")).toBeNull()
  expect(calls).toHaveLength(1)
})

test("prices can be looked up with the market closed, but nothing can be traded", async () => {
  const w = world({}, { enabled: false })
  feed(106.4)
  const reply = await w.say(A, "price eric-b.st")
  expect(reply!.response_type).toBe("ephemeral")
  expect(reply!.text).toContain("*ERIC-B.ST*")
  expect(reply!.text).toContain("*106.4 SEK*")
  expect((await w.say(A, "price"))!.text).toContain("which one?")
  expect((await w.say(A, "buy ERIC-B.ST 20"))!.text).toContain("the stock market is closed")
  expect(await market(w.ledger, { sub: "give", words: ["x"], user: A })).toBeNull()
  expect(w.balance(A)).toBe(100)
})

test("buying puts the coins in the market, less the fee, which the central bank gets", async () => {
  const w = world()
  feed(100)
  const reply = await w.say(A, "buy ERIC-B.ST 50")
  expect(reply!.response_type).toBe("in_channel")
  expect(reply!.text).toContain("<@UAAA>")
  expect(reply!.text).toContain("*50 coins*")
  expect([w.balance(A), w.balance(MARKET), w.balance(CENTRAL)]).toEqual([50, 49.5, 0.5])
  expect(w.position(A, "ERIC-B.ST")).toEqual({ units: 49.5, cost: 4950 })
  expect(w.total()).toBe(200)

  // Buying more of the same adds to the one position.
  await w.say(A, "buy 10 eric-b.st")
  expect(w.position(A, "ERIC-B.ST")).toEqual({ units: 59.4, cost: 5940 })
  expect(w.total()).toBe(200)
})

test("a trade needs a live price", async () => {
  const w = world()
  feed(100, { open: false })
  expect((await w.say(A, "buy ERIC-B.ST 50"))!.text).toContain("Stockholm is closed")
  w.later(100, { ago: 11 * 60 })
  expect((await w.say(A, "buy ERIC-B.ST 50"))!.text).toContain("its last trade was 11 minutes ago")
  w.later(null)
  expect((await w.say(A, "buy NOPE 50"))!.text).toContain("no price for `NOPE`")
  expect(w.balance(A)).toBe(100)
  expect(w.balance(MARKET)).toBe(0)
})

test("selling at a profit pays today's price, and the market prints only what it lacks", async () => {
  const w = world()
  feed(100)
  await w.say(A, "buy ERIC-B.ST 50")
  w.later(120)
  const reply = await w.say(A, "sell ERIC-B.ST all")
  expect(reply!.response_type).toBe("in_channel")
  expect(reply!.text).toContain("+20.0%")
  // 49.50 in, worth 59.40 at 120. The market held 49.50, so it printed 9.90. The fee on the way out is 0.59.
  expect(w.balance(A)).toBe(108.81)
  expect(w.balance(MARKET)).toBe(0)
  expect(w.balance(CENTRAL)).toBe(1.09)
  expect(w.position(A, "ERIC-B.ST")).toBeNull()
  expect(w.total()).toBe(209.9)
  expect(w.total()).toBe(w.created())
})

test("a loss stays in the market, and pays for the next person's gain before anything is printed", async () => {
  const w = world()
  feed(100)
  await w.say(A, "buy ERIC-B.ST 50")
  w.later(80)
  expect((await w.say(A, "sell ERIC-B.ST"))!.text).toContain("−20.0%")
  expect(w.balance(A)).toBe(89.2)
  expect(w.balance(MARKET)).toBe(9.9)
  expect(w.total()).toBe(200)

  await w.say(B, "buy ERIC-B.ST 50")
  w.later(88)
  await w.say(B, "sell ERIC-B.ST all")
  // B is up 10% on 49.50, which is 4.95: less than the 9.90 A left behind, so nothing new is created.
  expect(w.balance(MARKET)).toBe(4.95)
  expect(w.total()).toBe(200)
  expect(w.total()).toBe(w.created())
})

test("part of a position can be sold, and a remainder under a coin goes with it", async () => {
  const w = world()
  feed(100)
  await w.say(A, "buy ERIC-B.ST 100")
  expect(w.position(A, "ERIC-B.ST")).toEqual({ units: 99, cost: 9900 })
  await w.say(A, "sell ERIC-B.ST 40")
  const left = w.position(A, "ERIC-B.ST")!
  expect(left.cost).toBe(5900)
  expect(left.units).toBeCloseTo(59)
  expect(w.balance(A)).toBe(39.6)
  await w.say(A, "sell ERIC-B.ST 58.50")
  expect(w.position(A, "ERIC-B.ST")).toBeNull()
  expect(w.balance(MARKET)).toBe(0)
  expect(w.total()).toBe(200)
})

test("trades respect the minimum, the balance, what is owned and the pace", async () => {
  const w = world()
  feed(100)
  expect((await w.say(A, "buy ERIC-B.ST 0.5"))!.text).toContain("the smallest trade is 1 coin")
  expect((await w.say(A, "buy ERIC-B.ST"))!.text).toContain("the smallest trade is 1 coin")
  expect((await w.say(A, "buy 20"))!.text).toContain("say what and how much")
  expect((await w.say(A, "buy ERIC-B.ST 500"))!.text).toContain("100 coins")
  expect((await w.say(A, "sell ERIC-B.ST all"))!.text).toContain("you don't own any ERIC-B.ST")
  expect((await w.say(A, "portfolio"))!.text).toContain("you own nothing")
  for (let trade = 0; trade < 10; trade++) expect((await w.say(B, "buy ERIC-B.ST 1"))!.response_type).toBe("in_channel")
  expect((await w.say(B, "buy ERIC-B.ST 1"))!.text).toContain("slow down")
})

test("the portfolio values what is held at today's prices", async () => {
  const w = world()
  feed(100)
  await w.say(A, "buy ERIC-B.ST 50")
  w.later(110)
  const text = (await w.say(A, "portfolio"))!.text
  expect(text).toContain("*your portfolio* · 54.45 coins · +10.0%")
  expect(text).toContain("*ERIC-B.ST* · 54.45 coins · +10.0% on 49.50 coins")
  expect(await portfolio(w.ledger, A)).toEqual({
    enabled: true,
    fee: 1,
    positions: [{ symbol: "ERIC-B.ST", name: "Telefonaktiebolaget LM Ericsson (publ)", cost: 49.5, value: 54.45, live: true }],
  })
  w.later(null)
  expect((await portfolio(w.ledger, A)).positions[0]).toMatchObject({ value: null, live: false })
  expect((await portfolio(w.ledger, B)).positions).toEqual([])
})

test("trades read sensibly in a person's history", () => {
  expect(tradeLine({ kind: "buy", from_id: A, note: "ERIC-B.ST" }, A, "49.50 coins")).toBe("-49.50 coins into ERIC-B.ST")
  expect(tradeLine({ kind: "sell", from_id: MARKET, note: "ERIC-B.ST" }, A, "58.81 coins")).toBe("+58.81 coins from selling ERIC-B.ST")
  expect(tradeLine({ kind: "tax", from_id: A, note: "trading fee" }, A, "0.50 coins")).toBe("-0.50 coins trading fee")
  expect(tradeLine({ kind: "give", from_id: A, note: null }, A, "1 coin")).toBeNull()
})

test("help only lists what is switched on", () => {
  const open = world().config
  expect(casinoHelp(open).join("\n")).toContain("`/bank flip 10`")
  expect(casinoHelp(open)[0]).toBe("*casino* · bets up to 25 coins")
  expect(marketHelp(open)[0]).toBe("*stock market* · real prices, play money, 1% a trade")
  expect(marketHelp(open).join("\n")).toContain("`/bank sell ERIC-B.ST 20`")
  const closed = world({ enabled: false }, { enabled: false }).config
  expect(casinoHelp(closed)).toEqual([])
  expect(marketHelp(closed)).toEqual([])
})
