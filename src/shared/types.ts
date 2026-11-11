export type EmojiValue = { name: string; amount: number }

export type Games = {
  enabled: boolean
  /** The most anyone can stake on one bet. */
  maxBet: number
  /** What the house keeps. Whatever it wins beyond this goes to the central bank at the next draw. */
  reserve: number
}

export type Market = {
  enabled: boolean
  /** What a trade costs, in percent of its size. It goes to the central bank. */
  fee: number
}

/** Percentages, all paid to the central bank. Zero is off. */
export type Taxes = {
  /** Of every gift and reaction, out of what the recipient keeps. */
  transfer: number
  /** Of the profit on a casino win or a market sale. */
  winnings: number
  /** Each week, of whatever someone holds above `wealthAbove`. */
  wealth: number
  wealthAbove: number
  /** Not a tax: what the central bank pays on a one-week bond, out of its reserves. Zero means it sells none. */
  interest: number
}

/** Something an admin has put a price on. Bank takes the coins; handing it over is up to a human. */
export type ShopItem = { name: string; price: number }

export type Config = {
  singular: string
  plural: string
  /** Name of the workspace emoji that stands for the currency, without colons. */
  symbol: string
  starting: number
  emoji: EmojiValue[]
  notify: boolean
  games: Games
  market: Market
  taxes: Taxes
  shop: ShopItem[]
  /** The id of the channel the morning paper and the bank's other announcements go to. Empty until an admin picks one. */
  channel: string
}

export const defaultConfig: Config = {
  singular: "coin",
  plural: "coins",
  symbol: "coin-10",
  starting: 100,
  emoji: [
    { name: "coin-1", amount: 1 },
    { name: "coin-5", amount: 5 },
    { name: "coin-10", amount: 10 },
    { name: "coin-20", amount: 20 },
  ],
  notify: true,
  games: { enabled: false, maxBet: 25, reserve: 500 },
  market: { enabled: false, fee: 1 },
  taxes: { transfer: 0, winnings: 0, wealth: 0, wealthAbove: 200, interest: 0 },
  shop: [],
  channel: "",
}

/**
 * `bet` is a stake going to the house or the lottery pot, `payout` is what comes back, and `duel` goes from the loser
 * of a duel to the winner. `sweep` is the house handing its winnings beyond the reserve to the central bank, and
 * `stimulus` is the central bank paying out, to the lottery pot or to people.
 *
 * `buy` puts coins into the market against a share price and `sell` takes them out at the price of the day. `tax`
 * goes to the central bank. `print` is the market creating the coins it lacks to pay someone who sold at a profit:
 * along with a grant or an adjustment, the only kind that adds to how many coins exist.
 *
 * `bond` is coins going into a bond and coming back out, and `shop` is someone paying the central bank for something
 * an admin put a price on. `bounty` is coins put up for a job, or handed back when it is called off; paying one out is
 * a `give` from the bounty board, since that is what it is.
 */
export type EntryKind =
  | "grant"
  | "give"
  | "reaction"
  | "refund"
  | "adjust"
  | "bet"
  | "payout"
  | "duel"
  | "sweep"
  | "stimulus"
  | "buy"
  | "sell"
  | "tax"
  | "print"
  | "bond"
  | "shop"
  | "bounty"

/**
 * The accounts that aren't people. They hold coins like anyone else, so games move coins around without creating or
 * destroying any. The central bank collects what the house wins beyond its reserve and pays some of it back out.
 */
export const HOUSE = "HOUSE"
export const POT = "POT"
export const CENTRAL = "CENTRAL"
export const MARKET = "MARKET"
export const BONDS = "BONDS"
/** Holds what is staked on office bets until someone says how they went. */
export const POOLS = "POOLS"
/** Holds what is put up for bounties until it is paid to whoever did the job. */
export const BOUNTIES = "BOUNTIES"
export const INSTITUTIONS: Record<string, string> = {
  [HOUSE]: "the house",
  [POT]: "the lottery pot",
  [CENTRAL]: "the central bank",
  [MARKET]: "the market",
  [BONDS]: "the bond desk",
  [POOLS]: "the bookmaker",
  [BOUNTIES]: "the bounty board",
}

export type Entry = {
  id: number
  at: number
  kind: EntryKind
  from: string | null
  to: string | null
  amount: number
  note: string | null
  actor: string | null
  link: string | null
}

export type Account = {
  id: string
  name: string
  image: string | null
  balance: number
  received: number
  given: number
}

/**
 * Where someone's coins came from and went, beyond their starting balance. What colleagues gave them is kept apart
 * from the rest on purpose: that is what the bank is for, and a lucky night at the slots shouldn't look like it.
 */
export type Sources = {
  /** Given to them by people, less what they gave. */
  colleagues: number
  /** Won at the casino, less what they staked there. */
  casino: number
  /** Made or lost on positions they have closed. */
  market: number
  /** Paid in taxes and fees. */
  taxes: number
}

export type Me = {
  user: { id: string; name: string; image: string | null }
  team: { id: string; name: string; domain: string | null; icon: string | null }
  admin: boolean
  installed: boolean
  account: Account | null
  sources: Sources
  config: Config
  /** Image URLs for the workspace's custom emoji used by the config (the symbol and the reactions). */
  emoji: Record<string, string>
  /** Why Bank couldn't put its canvas in the bank's channel, if it couldn't. */
  canvasProblem: string | null
}

export const EMOJI_NAME = /^[a-z0-9_\-+'.]+$/

/** `titles` is what each person has earned, newest first, by their id. */
export type Leaderboard = { accounts: Account[]; titles: Record<string, string[]> }

export type History = { entries: Entry[]; people: Record<string, { name: string; image: string | null }> }

export type EconomyDay = {
  /** UTC date, YYYY-MM-DD. */
  day: string
  /** Every coin in existence at the end of the day. */
  supply: number
  /** Coins given between people that day. */
  gifts: number
  /** Coins staked on games that day. */
  bets: number
  /** Taxes and fees paid that day. */
  taxes: number
}

export type Economy = {
  supply: { people: number; house: number; pot: number; central: number; market: number; bonds: number; pools: number; bounties: number; total: number }
  /** Taxes and fees paid to the central bank over the last 7 and 30 days. */
  taxes: { week: number; month: number }
  members: number
  /** Coins created minus coins destroyed, over the last 7 and 30 days. */
  growth: { week: number; month: number }
  /** Coins given between people: the part of the economy where someone did something useful. */
  gdp: { week: number; month: number }
  /** Coins staked on games. */
  turnover: { week: number; month: number }
  /** Share of people's coins held by the richest person, 0 to 1. */
  richestShare: number
  /** 0 is everyone holding the same, 1 is one person holding everything. */
  gini: number
  /** People with nothing. */
  broke: number
  /** The last 30 days, oldest first. */
  days: EconomyDay[]
}

export type Gambler = { id: string; name: string; image: string | null }

/** Everything the casino has done, for the stats page. Amounts are in coins. */
export type CasinoStats = {
  /** Coins staked against the house and on lottery tickets, and coins that changed hands in duels. */
  staked: number
  bets: number
  /** What the house has taken in, less what it has paid out. */
  houseProfit: number
  /** What people have been given for doing something useful, to hold the casino's take up against. */
  gifts: number
  pot: number
  tickets: number
  games: { game: string; plays: number; staked: number; paid: number; wins: number }[]
  /** Net result per person, best first: winnings and duels won, less stakes and duels lost. */
  people: (Gambler & { net: number; staked: number; bets: number; wins: number; streak: number })[]
  biggestWin: (Gambler & { game: string; stake: number; paid: number; at: number }) | null
  jackpots: number
  /** Every lottery draw, oldest first. */
  draws: { at: number; pot: number; winner: Gambler }[]
  /** What the pot held at the end of each of the last 168 hours, oldest first. `at` is that moment, in milliseconds. */
  potHours: { at: number; pot: number }[]
  /** The house's running profit over the last 30 days, oldest first. */
  days: { day: string; profit: number }[]
}

export type Position = {
  symbol: string
  name: string
  /** What was put in, after fees. */
  cost: number
  /** What it would sell for now, before the fee, or null when there is no price to be had. */
  value: number | null
  /** Whether it can be traded this minute. */
  live: boolean
}

export type Portfolio = { positions: Position[]; fee: number; enabled: boolean }

/** How everyone has done in the stock market, for the Market tab. Amounts are in coins. */
export type MarketStats = {
  /** What the market account holds: losses not yet paid out as someone else's gain. */
  holds: number
  /** Coins the market has created to pay gains it couldn't cover. */
  printed: number
  /** Trading fees collected for the central bank. */
  fees: number
  /** Best first. `result` is what they've taken out plus what they still hold, less what they put in and paid in fees. */
  investors: (Gambler & { result: number; value: number; trades: number })[]
  /** What is held across everyone, biggest first. `value` is null when there is no price. */
  symbols: { symbol: string; name: string; holders: number; cost: number; value: number | null }[]
}

export type Admin = { id: string; name: string; image: string | null; source: "installer" | "added" | "slack" }

export type CustomEmoji = { name: string; url: string }

export type Channel = { id: string; name: string }

/** The ledger counts in hundredths of a coin. Everything shown to people, and sent to the web app, is in coins. */
export const CENTS = 100

/** An amount of coins as whole cents, or null when it isn't a number with at most two decimals. */
export function toCents(coins: number | string | null | undefined) {
  const text = typeof coins === "number" ? String(coins) : (coins ?? "").trim()
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) return null
  const cents = Math.round(Number(text) * CENTS)
  return Number.isSafeInteger(cents) ? cents : null
}

/** Coins as text: whole when they are whole, otherwise to the cent. 103, 103.50, 0.05. */
export function amountText(coins: number) {
  return Number.isInteger(coins) ? String(coins) : coins.toFixed(2)
}

export function currency(config: Config, amount: number) {
  return `${amountText(amount)} ${Math.abs(amount) === 1 ? config.singular : config.plural}`
}

const HOUR = 60 * 60 * 1000
const stockholmHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Stockholm", hour: "2-digit", hourCycle: "h23" })

/** The lottery is drawn every day at 09:00 in Stockholm, summer and winter. This is the next one after `now`. */
export function nextDraw(now: number) {
  let at = (Math.floor(now / HOUR) + 1) * HOUR
  while (Number(stockholmHour.format(at)) !== 9) at += HOUR
  return at
}
