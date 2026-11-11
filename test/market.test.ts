// The price lookup, against canned answers from the feed. No network.
import { afterEach, expect, test } from "bun:test"
import { fetchQuote, market, quote } from "../src/server/market"
import type { Ledger } from "../src/server/casino"

const realFetch = globalThis.fetch
afterEach(() => void (globalThis.fetch = realFetch))

const NOW = Date.UTC(2026, 10, 11, 10)
const chart = (meta: Record<string, unknown>) => ({ chart: { result: [{ meta }] } })
const ericsson = {
  symbol: "ERIC-B.ST",
  currency: "SEK",
  longName: "Telefonaktiebolaget LM Ericsson (publ)",
  fullExchangeName: "Stockholm",
  regularMarketPrice: 106.4,
  regularMarketTime: NOW / 1000 - 30,
  currentTradingPeriod: { regular: { start: NOW / 1000 - 7200, end: NOW / 1000 + 7200 } },
}
function feed(answer: unknown, status = 200) {
  const calls: string[] = []
  globalThis.fetch = (async (url: string) => (calls.push(String(url)), new Response(JSON.stringify(answer), { status }))) as never
  return calls
}
function ledger() {
  const meta = new Map<string, unknown>()
  return { meta: (key: string) => (meta.get(key) ?? null) as never, setMeta: (key: string, value: unknown) => void meta.set(key, value) } as unknown as Ledger
}

test("a quote carries the price, its currency, its age and whether the market is open", async () => {
  feed(chart(ericsson))
  expect(await fetchQuote("ERIC-B.ST", NOW)).toEqual({
    symbol: "ERIC-B.ST",
    name: "Telefonaktiebolaget LM Ericsson (publ)",
    price: 106.4,
    currency: "SEK",
    exchange: "Stockholm",
    at: NOW - 30_000,
    open: true,
  })
  feed(chart({ ...ericsson, currentTradingPeriod: { regular: { start: NOW / 1000 - 9000, end: NOW / 1000 - 1800 } } }))
  expect((await fetchQuote("ERIC-B.ST", NOW))!.open).toBe(false)
})

test("anything odd from the feed is no quote at all", async () => {
  feed({ chart: { result: null, error: { code: "Not Found" } } }, 404)
  expect(await fetchQuote("NOPE")).toBeNull()
  feed(chart({ ...ericsson, regularMarketPrice: 0 }))
  expect(await fetchQuote("ERIC-B.ST")).toBeNull()
  feed(chart({ ...ericsson, currency: undefined }))
  expect(await fetchQuote("ERIC-B.ST")).toBeNull()
  feed("<html>blocked</html>", 429)
  expect(await fetchQuote("ERIC-B.ST")).toBeNull()
  globalThis.fetch = (async () => Promise.reject(new Error("down"))) as never
  expect(await fetchQuote("ERIC-B.ST")).toBeNull()
})

test("quotes are reused for a minute, and symbols that aren't symbols never reach the feed", async () => {
  const calls = feed(chart(ericsson))
  const book = ledger()
  expect((await quote(book, "eric-b.st"))!.price).toBe(106.4)
  expect((await quote(book, "ERIC-B.ST"))!.price).toBe(106.4)
  expect(calls).toHaveLength(1)
  expect(await quote(book, "../../etc/passwd")).toBeNull()
  expect(await quote(book, "A B")).toBeNull()
  expect(calls).toHaveLength(1)
})

test("/bank price answers privately, and leaves other commands alone", async () => {
  feed(chart(ericsson))
  const reply = await market(ledger(), { sub: "price", words: ["eric-b.st"] })
  expect(reply!.response_type).toBe("ephemeral")
  expect(reply!.text).toContain("*ERIC-B.ST*")
  expect(reply!.text).toContain("*106.4 SEK*")
  expect(reply!.text).toContain("Stockholm")
  expect((await market(ledger(), { sub: "price", words: [] }))!.text).toContain("which one?")
  expect(await market(ledger(), { sub: "give", words: ["x"] })).toBeNull()
  feed({}, 404)
  expect((await market(ledger(), { sub: "price", words: ["<@U123>"] }))!.text).toContain("no price for `U123`")
})
