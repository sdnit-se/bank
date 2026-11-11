// Taxes, all of them paid to the central bank, and the interest and stimulus that pay the central bank back out.
//
// - transfer: a share of every gift and reaction, taken from what the recipient gets to keep. The gift still counts
//   in full toward what they have been given, so being thanked is worth the same on the leaderboard.
// - winnings: a share of the profit on a casino win or a sale in the market. Stakes and losses are never taxed.
// - wealth: once a week, a share of whatever anyone holds above a threshold.
// - interest: once a week, a share of whatever anyone holds, paid to them from the central bank's reserves.
//
// Every rate is a percentage and starts at zero. Amounts here are in cents, like the rest of the ledger.

import { CENTRAL, type Config } from "../shared/types"
import type { Ledger } from "./ledger"
import { money } from "./money"

const WEEK = 7 * 24 * 60 * 60 * 1000

/** Takes `rate` percent of `amount` from someone for the central bank, and says how much that was. */
export function levy(ledger: Ledger, input: { from: string; amount: number; rate: number; note: string; actor?: string | null }) {
  if (!(input.rate > 0) || !(input.amount > 0)) return 0
  const tax = Math.round((input.amount * input.rate) / 100)
  if (tax <= 0) return 0
  return ledger.move({ from: input.from, to: CENTRAL, amount: tax, kind: "tax", note: input.note, actor: input.actor ?? input.from }).ok ? tax : 0
}

/** A few words to put after a result when tax was taken from it. */
export function taxed(config: Config, tax: number) {
  return tax > 0 ? ` the taxman took ${money(config, tax)}.` : ""
}

/** True once a week for each `key`. The first time only starts the week, so nothing happens the moment a rate is set. */
function weekIsUp(ledger: Ledger, key: string, now: number) {
  const last = ledger.meta<number>(key)
  if (last !== null && now - last < WEEK) return false
  ledger.setMeta(key, now)
  return last !== null
}

/** Collects the wealth tax if a week has passed since the last time. */
export function collectWealth(ledger: Ledger, now = Date.now()) {
  const config = ledger.config()
  if (!(config.taxes.wealth > 0) || !weekIsUp(ledger, "wealth_taxed", now)) return null
  const rich = ledger.sql
    .exec<{ id: string; balance: number }>("select id, balance from accounts where bot = 0 and gone = 0 and balance > ? order by balance desc", config.taxes.wealthAbove)
    .toArray()
  let collected = 0
  let payers = 0
  for (const person of rich) {
    const tax = levy(ledger, { from: person.id, amount: person.balance - config.taxes.wealthAbove, rate: config.taxes.wealth, note: "wealth tax", actor: null })
    if (tax > 0) payers++
    collected += tax
  }
  return { collected, payers }
}

/**
 * Pays a week's interest on what everyone holds, out of the central bank's reserves. It never prints: when the
 * reserves fall short, everyone gets the same fraction of what they were due.
 */
export function payInterest(ledger: Ledger, now = Date.now()) {
  const rate = ledger.config().taxes.interest
  if (!(rate > 0) || !weekIsUp(ledger, "interest_paid", now)) return null
  const savers = ledger.sql.exec<{ id: string; balance: number }>("select id, balance from accounts where bot = 0 and gone = 0 and balance > 0 order by id").toArray()
  const due = savers.reduce((sum, saver) => sum + Math.round((saver.balance * rate) / 100), 0)
  const share = Math.min(1, due > 0 ? (ledger.row(CENTRAL)?.balance ?? 0) / due : 0)
  let [paid, people] = [0, 0]
  for (const saver of savers) {
    const amount = Math.floor(Math.round((saver.balance * rate) / 100) * share)
    if (amount <= 0 || !ledger.move({ from: CENTRAL, to: saver.id, amount, kind: "stimulus", note: "interest" }).ok) continue
    paid += amount
    people++
  }
  return { paid, people }
}

/** Splits `total` from the central bank's reserves equally between everyone active. Returns what each person got. */
export function stimulus(ledger: Ledger, total: number, actor: string) {
  const people = ledger.sql.exec<{ id: string }>("select id from accounts where bot = 0 and gone = 0 order by id").toArray()
  if (!people.length) throw new Error("there is nobody to pay")
  const each = Math.floor(total / people.length)
  if (!Number.isSafeInteger(total) || each <= 0) throw new Error("that is less than a cent each")
  const reserves = ledger.row(CENTRAL)?.balance ?? 0
  if (each * people.length > reserves) throw new Error(`the central bank only holds ${money(ledger.config(), reserves)}`)
  for (const person of people) ledger.move({ from: CENTRAL, to: person.id, amount: each, kind: "stimulus", note: "stimulus", actor })
  return { each, people: people.length }
}
