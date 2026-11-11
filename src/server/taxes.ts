// Taxes, all of them paid to the central bank, and the stimulus that pays the central bank back out.
//
// - transfer: a share of every gift and reaction, taken from what the recipient gets to keep. The gift still counts
//   in full toward what they have been given, so being thanked is worth the same on the leaderboard.
// - winnings: a share of the profit on a casino win or a sale in the market. Stakes and losses are never taxed.
// - wealth: once a week, a share of whatever anyone holds above a threshold.
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

/**
 * Collects the wealth tax if a week has passed since the last time. Turning the tax on starts the week, so nobody is
 * taxed the moment an admin saves the setting.
 */
export function collectWealth(ledger: Ledger, now = Date.now()) {
  const config = ledger.config()
  if (!(config.taxes.wealth > 0)) return null
  const last = ledger.meta<number>("wealth_taxed")
  if (last === null) {
    ledger.setMeta("wealth_taxed", now)
    return null
  }
  if (now - last < WEEK) return null
  ledger.setMeta("wealth_taxed", now)
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
