export type EmojiValue = { name: string; amount: number }

export type Games = {
  enabled: boolean
  /** The most anyone can stake on one bet. */
  maxBet: number
  /** What the house keeps. Whatever it wins beyond this goes to the central bank at the next draw. */
  reserve: number
}

export type Config = {
  singular: string
  plural: string
  /** Name of the workspace emoji that stands for the currency, without colons. */
  symbol: string
  starting: number
  emoji: EmojiValue[]
  notify: boolean
  games: Games
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
}

/**
 * `bet` is a stake going to the house or the lottery pot, `payout` is what comes back, and `duel` goes from the loser
 * of a duel to the winner. `sweep` is the house handing its winnings beyond the reserve to the central bank, and
 * `stimulus` is the central bank paying out, to the lottery pot or to people.
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

/**
 * The accounts that aren't people. They hold coins like anyone else, so games move coins around without creating or
 * destroying any. The central bank collects what the house wins beyond its reserve and pays some of it back out.
 */
export const HOUSE = "HOUSE"
export const POT = "POT"
export const CENTRAL = "CENTRAL"
export const INSTITUTIONS: Record<string, string> = {
  [HOUSE]: "the house",
  [POT]: "the lottery pot",
  [CENTRAL]: "the central bank",
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

export type Me = {
  user: { id: string; name: string; image: string | null }
  team: { id: string; name: string; domain: string | null; icon: string | null }
  admin: boolean
  installed: boolean
  account: Account | null
  config: Config
  /** Image URLs for the workspace's custom emoji used by the config (the symbol and the reactions). */
  emoji: Record<string, string>
}

export const EMOJI_NAME = /^[a-z0-9_\-+'.]+$/

export type Leaderboard = { accounts: Account[] }

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
}

export type Economy = {
  supply: { people: number; house: number; pot: number; central: number; total: number }
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

export type Admin = { id: string; name: string; image: string | null; source: "installer" | "added" | "slack" }

export type CustomEmoji = { name: string; url: string }

export function currency(config: Config, amount: number) {
  return `${amount} ${Math.abs(amount) === 1 ? config.singular : config.plural}`
}
