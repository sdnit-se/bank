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

import { CENTRAL, CENTS, MARKET, toCents, type Config, type MarketStats, type Portfolio } from "../shared/types"
import { brokeLine, say, secureRand, type Line } from "./games"
import { money } from "./money"
import { people } from "./stats"
import { loud, quiet, tooFast, type Ledger, type Message } from "./ledger"
import { levy, taxed as taxNote } from "./taxes"

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

type Held = { symbol: string; units: number; cost: number }

const SYMBOL = /^[A-Z0-9][A-Z0-9.\-=^]{0,14}$/
const AMOUNT = /^\d+(\.\d{1,2})?$/
const MINUTE = 60_000
/** How long a quote is reused before asking again. */
const FRESH = MINUTE
/** A price older than this is not one to trade on. */
const LIVE = 10 * MINUTE

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

const BOUGHT: Line[] = [
  (w) => `${w.user} put *${w.amount}* into ${w.symbol} at ${w.price}. ${w.name} thanks you for your service.`,
  (w) => `${w.user} bought *${w.amount}* of ${w.symbol} at ${w.price}. this is not financial advice, and neither was whatever made you do that.`,
  (w) => `${w.user} is now *${w.amount}* deep in ${w.symbol}. diamond hands, paper brain.`,
  (w) => `${w.user} just bought ${w.symbol} for *${w.amount}*. the top was probably in right before that.`,
]

const SOLD_UP: Line[] = [
  (w) => `${w.user} sold ${w.symbol} for *${w.amount}*, up ${w.change}. insufferable until further notice.`,
  (w) => `${w.user} cashed out ${w.symbol} for *${w.amount}*, a profit of ${w.profit} (${w.change}). even a blind squirrel.`,
  (w) => `${w.user} took *${w.amount}* out of ${w.symbol}, ${w.change}. will now explain investing to everyone at lunch.`,
]

const SOLD_DOWN: Line[] = [
  (w) => `${w.user} sold ${w.symbol} for *${w.amount}*, down ${w.change}. buy high, sell low, as tradition demands.`,
  (w) => `${w.user} took a ${w.profit} loss on ${w.symbol} (${w.change}). the stock didn't fail you, your timing did.`,
  (w) => `${w.user} got *${w.amount}* back out of ${w.symbol}, ${w.change}. a tuition payment to the market.`,
]

const SOLD_FLAT: Line[] = [(w) => `${w.user} sold ${w.symbol} for *${w.amount}*, exactly what went in. a round trip to nowhere, minus fees.`]

// ---------- slash commands

/** The market's part of `/bank help`: nothing at all while it's closed. */
export function marketHelp(config: Config) {
  if (!config.market.enabled) return []
  return [
    `*stock market* · real prices, play money, ${config.market.fee}% a trade`,
    `\`/bank buy ERIC-B.ST 20\` · put 20 into Ericsson. \`AAPL\`, \`005930.KS\`, \`BTC-USD\` work too`,
    `\`/bank sell ERIC-B.ST 20\` · take 20 out at today's price, or \`all\``,
    `\`/bank portfolio\` · what you hold and what it's worth`,
    `\`/bank price ERIC-B.ST\` · look a price up`,
  ]
}

/** What someone asked of the market: the symbol they named and the amount they typed, if any. */
type Ask = {
  ledger: Ledger
  config: Config
  user: string
  named: string | undefined
  /** The amount in cents, or null for none typed. `everything` is "all". */
  amount: number | null
  everything: boolean
  coins(cents: number): string
}

type Desk = (ask: Ask) => Message | Promise<Message>

const noPrice = (named: string) =>
  quiet(`no price for \`${named.toUpperCase().replace(/[^A-Z0-9.\-=^]/g, "").slice(0, 15)}\`. symbols are Yahoo Finance's: \`ERIC-B.ST\`, \`AAPL\`, \`BTC-USD\`.`)

type Valued = Held & { user_id: string; found: Quote | null; worth: number | null }

/** What one person holds, or everyone, with today's quote and what it comes to. Each symbol is asked for once. */
async function valued(ledger: Ledger, user: string | null = null): Promise<Valued[]> {
  const held = ledger.sql
    .exec<Held & { user_id: string }>("select user_id, symbol, units, cost from positions where ?1 is null or user_id = ?1 order by symbol", user)
    .toArray()
  const quotes = new Map(await Promise.all([...new Set(held.map((position) => position.symbol))].map(async (symbol) => [symbol, await quote(ledger, symbol)] as const)))
  return held.map((position) => {
    const found = quotes.get(position.symbol) ?? null
    return { ...position, found, worth: found ? Math.floor(position.units * found.price) : null }
  })
}

const price: Desk = async ({ ledger, named }) => {
  if (!named) return quiet("which one? `/bank price ERIC-B.ST`, `/bank price AAPL`, `/bank price BTC-USD`")
  const found = await quote(ledger, named)
  if (!found) return noPrice(named)
  return quiet(
    `*${found.symbol}* · ${found.name} · *${priced(found)}* · ${found.exchange} · ${found.open ? "market open" : "market closed"} · last traded ${age(found.at)}`,
  )
}

const holdings: Desk = async ({ ledger, config, user, coins }) => {
  const held = await valued(ledger, user)
  if (!held.length) {
    return quiet(
      `you own nothing. \`/bank buy ERIC-B.ST 20\` puts 20 coins into Ericsson, \`/bank sell ERIC-B.ST all\` takes them out at today's price. each trade costs ${config.market.fee}%.`,
    )
  }
  const cost = held.reduce((sum, position) => sum + position.cost, 0)
  const value = held.reduce((sum, position) => sum + (position.worth ?? position.cost), 0)
  const lines = held.map((position) =>
    position.found && position.worth !== null
      ? `*${position.symbol}* · ${coins(position.worth)} · ${percent(position.worth / position.cost - 1)} on ${coins(position.cost)}${live(position.found) ? "" : " · closed"}`
      : `*${position.symbol}* · ${coins(position.cost)} put in · no price right now`,
  )
  return quiet(`*your portfolio* · ${coins(value)} · ${percent(value / cost - 1)}\n${lines.join("\n")}`)
}

/** A purchase or a sale. Both need a symbol, a steady pace and a live price before any coins move. */
async function trade({ ledger, user, named }: Ask, usage: string, settle: (found: Quote) => Message | Promise<Message>) {
  if (!named) return quiet(`say what and how much: ${usage}`)
  if (tooFast(ledger, user, ["buy", "sell"])) return quiet("slow down. this is a stock market, not a slot machine. that's the other command.")
  const found = await quote(ledger, named)
  if (!found) return noPrice(named)
  if (!live(found)) {
    return quiet(
      `${found.symbol} isn't trading right now: ${found.open ? `its last trade was ${age(found.at)}` : `${found.exchange || "its exchange"} is closed`}. trades need a live price, or you'd all be buying yesterday's news.`,
    )
  }
  return settle(found)
}

const fee = (config: Config, cents: number) => Math.min(cents, Math.round((cents * config.market.fee) / 100))

const BUY = "`/bank buy ERIC-B.ST 20`"
const buy: Desk = (ask) =>
  trade(ask, BUY, async (found) => {
    const { ledger, config, user, coins } = ask
    const amount = ask.amount ?? 0
    if (amount < CENTS) return quiet(`the smallest trade is ${coins(CENTS)}: ${BUY}`)
    const row = (await ledger.ensure([user])).get(user)
    if (!row || row.gone) return quiet("only members of this workspace get to lose money here.")
    if (row.balance < amount) return quiet(brokeLine(secureRand, { balance: coins(row.balance) }))
    const taxed = fee(config, amount)
    const invested = amount - taxed
    if (!ledger.move({ from: user, to: MARKET, amount: invested, kind: "buy", note: found.symbol, actor: user }).ok) return quiet("something went wrong, try again")
    if (taxed > 0) ledger.move({ from: user, to: CENTRAL, amount: taxed, kind: "tax", note: "trading fee", actor: user })
    ledger.sql.exec(
      `insert into positions (user_id, symbol, units, cost) values (?, ?, ?, ?)
        on conflict (user_id, symbol) do update set units = units + excluded.units, cost = cost + excluded.cost`,
      user,
      found.symbol,
      invested / found.price,
      invested,
    )
    return loud(`:chart_with_upwards_trend: ${say(secureRand, BOUGHT, { user: `<@${user}>`, amount: coins(amount), symbol: `*${found.symbol}*`, name: found.name, price: priced(found) })}`)
  })

const SELL = "`/bank sell ERIC-B.ST 20`, or `all`"
const sell: Desk = (ask) =>
  trade(ask, SELL, (found) => {
    const { ledger, config, user, coins } = ask
    const position = ledger.sql.exec<Held>("select symbol, units, cost from positions where user_id = ? and symbol = ?", user, found.symbol).toArray()[0]
    if (!position) return quiet(`you don't own any ${found.symbol}. \`/bank portfolio\` shows what you do own.`)
    const worth = Math.floor(position.units * found.price)
    const asked = ask.everything || ask.amount === null ? worth : ask.amount
    if (asked <= 0) return quiet(`say how much: ${SELL}`)
    // Asking for more than it's worth, or leaving less than a coin behind, sells the lot.
    const all = asked >= worth || worth - asked < CENTS
    const gross = all ? worth : asked
    const share = all ? 1 : gross / worth
    const basis = all ? position.cost : Math.round(position.cost * share)
    const taxed = fee(config, gross)

    // The market pays what the position is worth today. What it doesn't hold, it prints.
    const short = gross - (ledger.row(MARKET)?.balance ?? 0)
    if (short > 0) ledger.move({ from: null, to: MARKET, amount: short, kind: "print", note: found.symbol, actor: user })
    if (gross - taxed > 0) ledger.move({ from: MARKET, to: user, amount: gross - taxed, kind: "sell", note: found.symbol, actor: user })
    if (taxed > 0) ledger.move({ from: MARKET, to: CENTRAL, amount: taxed, kind: "tax", note: "trading fee", actor: user })
    if (all) ledger.sql.exec("delete from positions where user_id = ? and symbol = ?", user, found.symbol)
    else ledger.sql.exec("update positions set units = units * ?, cost = cost - ? where user_id = ? and symbol = ?", 1 - share, basis, user, found.symbol)

    const profit = gross - basis
    const tax = levy(ledger, { from: user, amount: profit, rate: config.taxes.winnings, note: "gains tax" })
    const lines = profit > 0 ? SOLD_UP : profit < 0 ? SOLD_DOWN : SOLD_FLAT
    return loud(
      `:chart_with_${profit < 0 ? "downwards" : "upwards"}_trend: ${say(secureRand, lines, {
        user: `<@${user}>`,
        amount: coins(gross - taxed),
        symbol: `*${found.symbol}*`,
        change: percent(basis > 0 ? gross / basis - 1 : 0),
        profit: coins(Math.abs(profit)),
      })}${taxNote(config, tax)}`,
    )
  })

/** Every word the market answers to. */
const DESKS = new Map<string, Desk>([
  ["price", price],
  ["quote", price],
  ["buy", buy],
  ["sell", sell],
  ["portfolio", holdings],
  ["stocks", holdings],
  ["market", holdings],
])

/** Answers a market command, or returns null when the words aren't the market's. */
export async function market(ledger: Ledger, input: { sub: string; words: string[]; user: string }): Promise<Message | null> {
  const desk = DESKS.get(input.sub)
  if (!desk) return null
  const config = ledger.config()
  // A price can be looked up with the market closed. Nothing else can be done.
  if (desk !== price && !config.market.enabled) return quiet(`the stock market is closed. an admin can open it at <${ledger.env.PUBLIC_URL}|the bank>.`)
  const word = input.words.find((word) => AMOUNT.test(word))
  return desk({
    ledger,
    config,
    user: input.user,
    named: input.words.find((word) => !AMOUNT.test(word) && !/^(all|everything|of|in|into|for)$/i.test(word)),
    amount: word ? (toCents(word) ?? 0) : null,
    everything: input.words.some((word) => /^(all|everything)$/i.test(word)),
    coins: (cents) => money(config, cents),
  })
}

/** What someone holds, valued now, in coins for the web app. */
export async function portfolio(ledger: Ledger, user: string): Promise<Portfolio> {
  const config = ledger.config()
  return {
    enabled: config.market.enabled,
    fee: config.market.fee,
    positions: (await valued(ledger, user)).map((position) => ({
      symbol: position.symbol,
      name: position.found?.name ?? position.symbol,
      cost: position.cost / CENTS,
      value: position.worth === null ? null : position.worth / CENTS,
      live: position.found ? live(position.found) : false,
    })),
  }
}

/** How everyone has done, with what they still hold valued at today's prices. */
export async function marketStats(ledger: Ledger): Promise<MarketStats> {
  const coins = (cents: number) => cents / CENTS
  const who = people(ledger)
  const held = await valued(ledger)
  const flows = ledger.sql
    .exec<{ user: string; bought: number; sold: number; trades: number }>(
      `select case when kind = 'buy' then from_id else to_id end as user,
        sum(case when kind = 'buy' then amount else 0 end) as bought,
        sum(case when kind = 'sell' then amount else 0 end) as sold,
        count(*) as trades
      from entries where kind in ('buy', 'sell') group by user`,
    )
    .toArray()
  // The fee on a purchase comes out of the buyer's pocket. The fee on a sale is already missing from what they got.
  const paid = new Map(
    ledger.sql
      .exec<{ user: string; fees: number }>("select from_id as user, sum(amount) as fees from entries where kind = 'tax' and note = 'trading fee' and from_id != ? group by from_id", MARKET)
      .toArray()
      .map((row) => [row.user, row.fees]),
  )
  const investors = flows
    .map((flow) => {
      const value = held.filter((position) => position.user_id === flow.user).reduce((sum, position) => sum + (position.worth ?? position.cost), 0)
      return { ...who(flow.user), result: coins(flow.sold + value - flow.bought - (paid.get(flow.user) ?? 0)), value: coins(value), trades: flow.trades }
    })
    .sort((a, b) => b.result - a.result || a.name.localeCompare(b.name))

  const bySymbol = new Map<string, { symbol: string; name: string; holders: number; cost: number; value: number | null }>()
  for (const position of held) {
    const row = bySymbol.get(position.symbol) ?? { symbol: position.symbol, name: position.found?.name ?? position.symbol, holders: 0, cost: 0, value: 0 }
    row.holders++
    row.cost += position.cost
    row.value = position.worth === null || row.value === null ? null : row.value + position.worth
    bySymbol.set(position.symbol, row)
  }
  const total = (kind: string, note: string | null = null) =>
    ledger.sql.exec<{ n: number | null }>("select sum(amount) as n from entries where kind = ?1 and (?2 is null or note = ?2)", kind, note).one().n ?? 0
  return {
    holds: coins(ledger.row(MARKET)?.balance ?? 0),
    printed: coins(total("print")),
    fees: coins(total("tax", "trading fee")),
    investors,
    symbols: [...bySymbol.values()]
      .sort((a, b) => b.cost - a.cost)
      .map((row) => ({ ...row, cost: coins(row.cost), value: row.value === null ? null : coins(row.value) })),
  }
}
