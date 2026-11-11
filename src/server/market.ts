// Real market prices, for the investment game. For now this only looks a price up: `/bank price ERIC-B.ST`.
//
// Quotes come from Yahoo Finance's chart endpoint, which needs no key and covers Stockholm, the US and crypto with
// one symbol format. It is unofficial, so everything here treats a missing or odd answer as "no quote" rather than
// trusting it.

import type { Ledger } from "./casino"

export type Quote = {
  symbol: string
  name: string
  price: number
  currency: string
  exchange: string
  /** When the price was last traded, in milliseconds. */
  at: number
  /** Whether the exchange is in its regular session right now. */
  open: boolean
}

type Message = { response_type: "ephemeral" | "in_channel"; text: string }

const SYMBOL = /^[A-Z0-9][A-Z0-9.\-=^]{0,14}$/
/** How long a quote is reused before asking again. */
const FRESH = 60_000

type Chart = {
  chart?: {
    result?: {
      meta?: {
        symbol?: string
        currency?: string
        longName?: string
        shortName?: string
        fullExchangeName?: string
        exchangeName?: string
        regularMarketPrice?: number
        regularMarketTime?: number
        currentTradingPeriod?: { regular?: { start?: number; end?: number } }
      }
    }[]
  }
}

export async function fetchQuote(symbol: string, now = Date.now()): Promise<Quote | null> {
  const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`, {
    // Without a browser-like agent the endpoint answers 429.
    headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", accept: "application/json" },
  }).catch(() => null)
  if (!response?.ok) return null
  const meta = ((await response.json().catch(() => null)) as Chart | null)?.chart?.result?.[0]?.meta
  if (!meta || typeof meta.regularMarketPrice !== "number" || !(meta.regularMarketPrice > 0) || !meta.regularMarketTime || !meta.currency) return null
  const session = meta.currentTradingPeriod?.regular
  return {
    symbol: meta.symbol ?? symbol,
    name: meta.longName ?? meta.shortName ?? symbol,
    price: meta.regularMarketPrice,
    currency: meta.currency,
    exchange: meta.fullExchangeName ?? meta.exchangeName ?? "",
    at: meta.regularMarketTime * 1000,
    open: Boolean(session?.start && session.end && now >= session.start * 1000 && now < session.end * 1000),
  }
}

/** A quote, at most a minute old as far as we know. */
export async function quote(ledger: Ledger, raw: string): Promise<Quote | null> {
  const symbol = raw.trim().toUpperCase()
  if (!SYMBOL.test(symbol)) return null
  const cached = ledger.meta<{ fetched: number; quote: Quote }>(`quote:${symbol}`)
  if (cached && Date.now() - cached.fetched < FRESH) return cached.quote
  const fresh = await fetchQuote(symbol)
  if (fresh) ledger.setMeta(`quote:${symbol}`, { fetched: Date.now(), quote: fresh })
  return fresh
}

function age(at: number, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 2) return "just now"
  if (minutes < 120) return `${minutes} minutes ago`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} hours ago`
  return `${Math.round(minutes / 1440)} days ago`
}

export async function market(ledger: Ledger, input: { sub: string; words: string[] }): Promise<Message | null> {
  if (input.sub !== "price" && input.sub !== "quote") return null
  const quiet = (text: string): Message => ({ response_type: "ephemeral", text })
  const symbol = input.words[0]
  if (!symbol) return quiet("which one? `/bank price ERIC-B.ST`, `/bank price AAPL`, `/bank price BTC-USD`")
  const found = await quote(ledger, symbol)
  if (!found) return quiet(`no price for \`${symbol.slice(0, 15).toUpperCase().replace(/[^A-Z0-9.\-=^]/g, "")}\`. symbols are Yahoo Finance's: \`ERIC-B.ST\`, \`AAPL\`, \`BTC-USD\`.`)
  const price = found.price.toLocaleString("en-US", { maximumFractionDigits: found.price < 10 ? 4 : 2 })
  return quiet(
    `*${found.symbol}* · ${found.name} · *${price} ${found.currency}* · ${found.exchange} · ${found.open ? "market open" : "market closed"} · last traded ${age(found.at)}`,
  )
}
