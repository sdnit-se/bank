// Savings bonds: lend the central bank coins for a week and get them back with interest. `/bank bond 50`.
//
// The coins lent sit in the bond account the whole week, so they always come back. The interest is paid from the
// central bank's reserves when the bond matures, at the rate it was bought at. Nothing is ever printed for it: if the
// reserves can't cover everything maturing that day, every bond gets the same fraction of its interest.
//
// Locked coins can't be bet, given away or taxed as wealth, which is the whole trade.

import { BONDS, CENTRAL, CENTS, toCents, type Config } from "../shared/types"
import { brokeLine, say, secureRand, type Line } from "./games"
import { held, loud, newsroom, quiet, schedule, tooFast, type Ledger, type Message } from "./ledger"
import { money } from "./money"

const WEEK = 7 * 24 * 60 * 60 * 1000

type Bond = { id: number; user_id: string; amount: number; rate: number; matures: number }

const BOUGHT: Line[] = [
  (w) => `${w.user} lent the central bank *${w.amount}* for a week at ${w.rate}. the most boring bet in the building, and the only one that pays.`,
  (w) => `${w.user} locked up *${w.amount}* at ${w.rate}. can't lose it at blackjack if it's in a bond.`,
  (w) => `${w.user} bought a bond: *${w.amount}* at ${w.rate}, back in a week with ${w.interest}. somewhere a financial adviser sheds a single proud tear.`,
]

const selling = (config: Config) => config.taxes.interest > 0

/** The bonds' part of `/bank help`: nothing at all while none are on sale. */
export function bondHelp(config: Config) {
  if (!selling(config)) return []
  return [
    `*bonds* · ${config.taxes.interest}% a week from the central bank`,
    `\`/bank bond 50\` · lock 50 away for a week and get it back with interest. locked coins aren't taxed as wealth`,
    `\`/bank bonds\` · what you have locked up`,
  ]
}

/** What someone has locked in bonds, in cents. */
export function bonded(ledger: Ledger, user: string) {
  return ledger.sql.exec<{ n: number | null }>("select sum(amount) as n from bonds where user_id = ?", user).one().n ?? 0
}

/** Answers a bond command, or returns null when the words aren't about bonds. */
export async function bonds(ledger: Ledger, input: { sub: string; words: string[]; user: string; channel: string | null }): Promise<Message | null> {
  if (input.sub !== "bond" && input.sub !== "bonds") return null
  const { user } = input
  const config = ledger.config()
  const coins = (cents: number) => money(config, cents)
  const rate = config.taxes.interest
  const offer = selling(config) ? `the central bank pays ${rate}% on a one-week bond: \`/bank bond 50\`` : "the central bank isn't selling bonds right now."

  const word = input.words.find((word) => /^\d+(\.\d{1,2})?$/.test(word))
  if (!word) {
    const mine = ledger.sql.exec<Bond>("select * from bonds where user_id = ? order by matures", user).toArray()
    if (!mine.length) return quiet(`you hold no bonds. ${offer}`)
    const lines = mine.map((bond) => `${coins(bond.amount)} at ${bond.rate}% · back <!date^${Math.floor(bond.matures / 1000)}^{date_short_pretty}|in a week>`)
    return quiet([`*your bonds* · ${coins(bonded(ledger, user))} locked up`, ...lines, offer].join("\n"))
  }

  if (!selling(config)) return quiet(offer)
  const amount = toCents(word) ?? 0
  if (amount < CENTS) return quiet(`the smallest bond is ${coins(CENTS)}: \`/bank bond 50\``)
  if (tooFast(ledger, user, ["bond"])) return quiet("slow down. it's a bond, it's supposed to be boring.")
  const row = (await ledger.ensure([user])).get(user)
  if (!row || row.gone) return quiet("only members of this workspace get to save here.")
  if (row.balance < amount) return quiet(brokeLine(secureRand, { balance: coins(row.balance) }))
  if (!ledger.move({ from: user, to: BONDS, amount, kind: "bond", note: `${rate}%`, actor: user }).ok) return quiet("something went wrong, try again")
  ledger.sql.exec("insert into bonds (user_id, amount, rate, matures) values (?, ?, ?, ?)", user, amount, rate, Date.now() + WEEK)
  // Bonds are paid back in the daily round, and announced wherever the bank last made an announcement.
  if (input.channel && !ledger.meta("lottery_channel")) ledger.setMeta("lottery_channel", input.channel)
  await schedule(ledger)
  const interest = coins(Math.round((amount * rate) / 100))
  return loud(`:scroll: ${say(secureRand, BOUGHT, { user: `<@${user}>`, amount: coins(amount), rate: `${rate}%`, interest })}`)
}

/**
 * Pays back every bond that has run its week: the coins lent, from the bond account, and the interest, from the
 * central bank's reserves as far as they go. Returns what happened, or null when nothing was due.
 */
export function matureBonds(ledger: Ledger, now = Date.now()) {
  const due = ledger.sql.exec<Bond>("select * from bonds where matures <= ? order by id", now).toArray()
  if (!due.length) return null
  const interest = (bond: Bond) => Math.round((bond.amount * bond.rate) / 100)
  const owed = due.reduce((sum, bond) => sum + interest(bond), 0)
  const share = owed > 0 ? Math.min(1, held(ledger, CENTRAL) / owed) : 1
  let [lent, paid] = [0, 0]
  for (const bond of due) {
    ledger.sql.exec("delete from bonds where id = ?", bond.id)
    ledger.move({ from: BONDS, to: bond.user_id, amount: bond.amount, kind: "bond", note: "matured" })
    const extra = Math.floor(interest(bond) * share)
    if (extra > 0) ledger.move({ from: CENTRAL, to: bond.user_id, amount: extra, kind: "stimulus", note: "bond interest" })
    lent += bond.amount
    paid += extra
  }
  return { owners: [...new Set(due.map((bond) => bond.user_id))], lent, paid, short: share < 1 }
}

/** Tells the channel when the bond rate moves, the way a central bank would. */
export async function announceRate(ledger: Ledger, before: number, after: number) {
  const channel = newsroom(ledger)
  if (before === after || !channel) return
  const text =
    after === 0
      ? ":classical_building: the central bank has stopped selling bonds. the ones already bought still pay what they promised."
      : `:classical_building: the central bank has ${before === 0 ? "opened the bond desk at" : after > before ? "raised its rate to" : "cut its rate to"} *${after}% a week*. \`/bank bond 50\` locks 50 away for a week at that rate.`
  await ledger.call("chat.postMessage", { channel, text, unfurl_links: false }).catch((error: unknown) => console.error("announcement failed", error))
}
