// The stock market: real prices, play money. `/bank price`, `/bank buy`, `/bank sell`, `/bank portfolio`.
//
// A position isn't a number of shares. It is coins put in at a price, and it is worth those coins times however
// much the price has moved since, so 50 coins in Ericsson and 50 coins in Bitcoin behave alike and no exchange rate
// is needed. A purchase pays into the market's account and a sale pays out of it at the price of the day. When the
// market can't cover someone who sold at a profit it prints the difference, which is the one way trading adds to the
// number of coins: losses pay for gains first. Each trade is taxed, and the tax goes to the central bank.
//
// Quotes come from Yahoo Finance's chart endpoint, which needs no key and covers Stockholm, the US and crypto with
// one symbol format. It is unofficial, so anything missing or odd in its answer means "no quote". A trade needs a
// live one: the exchange open and a last trade minutes old. Otherwise people would buy at yesterday's close on this
// morning's news.

import { CENTRAL, CENTS, MARKET, toCents, type Portfolio } from "../shared/types"
import type { Ledger } from "./casino"
import { brokeLine, secureRand, type Rand } from "./games"
import { money } from "./money"

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
type Held = { symbol: string; units: number; cost: number }

const SYMBOL = /^[A-Z0-9][A-Z0-9.\-=^]{0,14}$/
const AMOUNT = /^\d+(\.\d{1,2})?$/
const MINUTE = 60_000
/** How long a quote is reused before asking again. */
const FRESH = MINUTE
/** A price older than this is not one to trade on. */
const LIVE = 10 * MINUTE
const TRADES_A_MINUTE = 10
const COMMANDS = new Set(["price", "quote", "buy", "sell", "portfolio", "stocks", "market"])

export function setupMarket(sql: SqlStorage) {
  sql.exec(`
    create table if not exists positions (
      user_id text not null,
      symbol text not null,
      units real not null,
      cost integer not null,
      primary key (user_id, symbol)
    );
  `)
}

// ---------- prices

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

export function live(found: Quote, now = Date.now()) {
  return found.open && now - found.at <= LIVE
}

function age(at: number, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - at) / MINUTE))
  if (minutes < 2) return "just now"
  if (minutes < 120) return `${minutes} minutes ago`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} hours ago`
  return `${Math.round(minutes / 1440)} days ago`
}

const priced = (found: Quote) => `${found.price.toLocaleString("en-US", { maximumFractionDigits: found.price < 10 ? 4 : 2 })} ${found.currency}`
const percent = (ratio: number) => `${ratio >= 0 ? "+" : "−"}${Math.abs(ratio * 100).toFixed(1)}%`

// ---------- what Bank says

type Line = (words: Record<string, string>) => string
const say = (rand: Rand, lines: Line[], words: Record<string, string>) => lines[rand(lines.length)]!(words)

const BOUGHT: Line[] = [
  (w) => `${w.user} put *${w.amount}* into ${w.symbol} at ${w.price}. ${w.name} thanks you for your service.`,
  (w) => `${w.user} bought *${w.amount}* of ${w.symbol} at ${w.price}. this is not financial advice, and neither was whatever made you do that.`,
  (w) => `${w.user} is now *${w.amount}* deep in ${w.symbol}. diamond hands, paper brain.`,
  (w) => `${w.user} just bought ${w.symbol} for *${w.amount}*. the top was probably in right before that.`,
]

const SOLD_UP: Line[] = [
  (w) => `${w.user} sold ${w.symbol} for *${w.amount}*, up ${w.change}. insufferable until further notice.`,
  (w) => `${w.user} cashed out ${w.symbol} for *${w.amount}*, a profit of ${w.profit}. even a blind squirrel.`,
  (w) => `${w.user} took *${w.amount}* out of ${w.symbol}, ${w.change}. will now explain investing to everyone at lunch.`,
]

const SOLD_DOWN: Line[] = [
  (w) => `${w.user} sold ${w.symbol} for *${w.amount}*, down ${w.change}. buy high, sell low, as tradition demands.`,
  (w) => `${w.user} took a ${w.profit} loss on ${w.symbol}. the stock didn't fail you, your timing did.`,
  (w) => `${w.user} got *${w.amount}* back out of ${w.symbol}, ${w.change}. a tuition payment to the market.`,
]

const SOLD_FLAT: Line[] = [(w) => `${w.user} sold ${w.symbol} for *${w.amount}*, exactly what went in. a round trip to nowhere, minus fees.`]

// ---------- slash commands

export async function market(ledger: Ledger, input: { sub: string; words: string[]; user: string }): Promise<Message | null> {
  if (!COMMANDS.has(input.sub)) return null
  const quiet = (text: string): Message => ({ response_type: "ephemeral", text })
  const loud = (text: string): Message => ({ response_type: "in_channel", text })
  const config = ledger.config()
  const coins = (cents: number) => money(config, cents)
  const me = `<@${input.user}>`
  const word = input.words.find((word) => AMOUNT.test(word))
  const everything = input.words.some((word) => /^(all|everything)$/i.test(word))
  const named = input.words.find((word) => !AMOUNT.test(word) && !/^(all|everything|of|in|into|for)$/i.test(word))
  const clean = (named ?? "").toUpperCase().replace(/[^A-Z0-9.\-=^]/g, "").slice(0, 15)

  if (input.sub === "price" || input.sub === "quote") {
    if (!named) return quiet("which one? `/bank price ERIC-B.ST`, `/bank price AAPL`, `/bank price BTC-USD`")
    const found = await quote(ledger, named)
    if (!found) return quiet(`no price for \`${clean}\`. symbols are Yahoo Finance's: \`ERIC-B.ST\`, \`AAPL\`, \`BTC-USD\`.`)
    return quiet(
      `*${found.symbol}* · ${found.name} · *${priced(found)}* · ${found.exchange} · ${found.open ? "market open" : "market closed"} · last traded ${age(found.at)}`,
    )
  }

  if (!config.market.enabled) return quiet(`the stock market is closed. an admin can open it at <${ledger.env.PUBLIC_URL}|the bank>.`)

  const positions = () => ledger.sql.exec<Held>("select symbol, units, cost from positions where user_id = ? order by symbol", input.user).toArray()

  if (input.sub === "portfolio" || input.sub === "stocks" || input.sub === "market") {
    const held = positions()
    if (!held.length) {
      return quiet(
        `you own nothing. \`/bank buy ERIC-B.ST 20\` puts 20 coins into Ericsson, \`/bank sell ERIC-B.ST all\` takes them out at today's price. each trade costs ${config.market.fee}%.`,
      )
    }
    let [cost, value] = [0, 0]
    const lines = await Promise.all(
      held.map(async (position) => {
        const found = await quote(ledger, position.symbol)
        const worth = found ? Math.floor(position.units * found.price) : position.cost
        cost += position.cost
        value += worth
        return found
          ? `*${position.symbol}* · ${coins(worth)} · ${percent(worth / position.cost - 1)} on ${coins(position.cost)}${live(found) ? "" : " · closed"}`
          : `*${position.symbol}* · ${coins(position.cost)} put in · no price right now`
      }),
    )
    return quiet(`*your portfolio* · ${coins(value)} · ${percent(value / cost - 1)}\n${lines.join("\n")}`)
  }

  // buy and sell
  const usage = input.sub === "buy" ? "`/bank buy ERIC-B.ST 20`" : "`/bank sell ERIC-B.ST 20`, or `all`"
  if (!named) return quiet(`say what and how much: ${usage}`)
  const recent = ledger.sql
    .exec<{ n: number }>("select count(*) as n from entries where actor = ? and kind in ('buy', 'sell') and at > ?", input.user, Date.now() - MINUTE)
    .one().n
  if (recent >= TRADES_A_MINUTE) return quiet("slow down. this is a stock market, not a slot machine. that's the other command.")
  const found = await quote(ledger, named)
  if (!found) return quiet(`no price for \`${clean}\`. symbols are Yahoo Finance's: \`ERIC-B.ST\`, \`AAPL\`, \`BTC-USD\`.`)
  if (!live(found)) {
    return quiet(
      `${found.symbol} isn't trading right now: ${found.open ? `its last trade was ${age(found.at)}` : `${found.exchange || "its exchange"} is closed`}. trades need a live price, or you'd all be buying yesterday's news.`,
    )
  }
  const fee = (cents: number) => Math.min(cents, Math.round((cents * config.market.fee) / 100))

  if (input.sub === "buy") {
    const amount = word ? (toCents(word) ?? 0) : 0
    if (amount < CENTS) return quiet(`the smallest trade is ${coins(CENTS)}: ${usage}`)
    const row = (await ledger.ensure([input.user])).get(input.user)
    if (!row || row.gone) return quiet("only members of this workspace get to lose money here.")
    if (row.balance < amount) return quiet(brokeLine(secureRand, { balance: coins(row.balance) }))
    const taxed = fee(amount)
    const invested = amount - taxed
    const paid = ledger.move({ from: input.user, to: MARKET, amount: invested, kind: "buy", note: found.symbol, actor: input.user })
    if (!paid.ok) return quiet("something went wrong, try again")
    if (taxed > 0) ledger.move({ from: input.user, to: CENTRAL, amount: taxed, kind: "tax", note: "trading fee", actor: input.user })
    ledger.sql.exec(
      `insert into positions (user_id, symbol, units, cost) values (?, ?, ?, ?)
        on conflict (user_id, symbol) do update set units = units + excluded.units, cost = cost + excluded.cost`,
      input.user,
      found.symbol,
      invested / found.price,
      invested,
    )
    return loud(`:chart_with_upwards_trend: ${say(secureRand, BOUGHT, { user: me, amount: coins(amount), symbol: `*${found.symbol}*`, name: found.name, price: priced(found) })}`)
  }

  const position = positions().find((held) => held.symbol === found.symbol)
  if (!position) return quiet(`you don't own any ${found.symbol}. \`/bank portfolio\` shows what you do own.`)
  const worth = Math.floor(position.units * found.price)
  const asked = everything || !word ? worth : (toCents(word) ?? 0)
  if (asked <= 0) return quiet(`say how much: ${usage}`)
  // Asking for more than it's worth, or leaving less than a coin behind, sells the lot.
  const all = asked >= worth || worth - asked < CENTS
  const gross = all ? worth : asked
  const share = all ? 1 : gross / worth
  const basis = all ? position.cost : Math.round(position.cost * share)
  const taxed = fee(gross)

  // The market pays what the position is worth today. What it doesn't hold, it prints.
  const short = gross - (ledger.row(MARKET)?.balance ?? 0)
  if (short > 0) ledger.move({ from: null, to: MARKET, amount: short, kind: "print", note: found.symbol, actor: input.user })
  if (gross - taxed > 0) ledger.move({ from: MARKET, to: input.user, amount: gross - taxed, kind: "sell", note: found.symbol, actor: input.user })
  if (taxed > 0) ledger.move({ from: MARKET, to: CENTRAL, amount: taxed, kind: "tax", note: "trading fee", actor: input.user })
  if (all) ledger.sql.exec("delete from positions where user_id = ? and symbol = ?", input.user, found.symbol)
  else ledger.sql.exec("update positions set units = units * ?, cost = cost - ? where user_id = ? and symbol = ?", 1 - share, basis, input.user, found.symbol)

  const profit = gross - basis
  const lines = profit > 0 ? SOLD_UP : profit < 0 ? SOLD_DOWN : SOLD_FLAT
  return loud(
    `:chart_with_${profit < 0 ? "downwards" : "upwards"}_trend: ${say(secureRand, lines, {
      user: me,
      amount: coins(gross - taxed),
      symbol: `*${found.symbol}*`,
      change: percent(basis > 0 ? gross / basis - 1 : 0),
      profit: coins(Math.abs(profit)),
    })}`,
  )
}

/** How a market entry reads in `/bank history`, or null when the entry isn't one. */
export function tradeLine(row: { kind: string; from_id: string | null; note: string | null }, user: string, amount: string) {
  if (row.kind === "buy") return `-${amount} into ${row.note ?? "the market"}`
  if (row.kind === "sell") return `+${amount} from selling ${row.note ?? "a position"}`
  if (row.kind === "tax") return row.from_id === user ? `-${amount} ${row.note ?? "tax"}` : null
  return null
}

/** What someone holds, valued now, in coins for the web app. */
export async function portfolio(ledger: Ledger, user: string): Promise<Portfolio> {
  const config = ledger.config()
  const held = ledger.sql.exec<Held>("select symbol, units, cost from positions where user_id = ? order by symbol", user).toArray()
  return {
    enabled: config.market.enabled,
    fee: config.market.fee,
    positions: await Promise.all(
      held.map(async (position) => {
        const found = await quote(ledger, position.symbol)
        return {
          symbol: position.symbol,
          name: found?.name ?? position.symbol,
          cost: position.cost / CENTS,
          value: found ? Math.floor(position.units * found.price) / CENTS : null,
          live: found ? live(found) : false,
        }
      }),
    ),
  }
}
