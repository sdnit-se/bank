// Begging: someone who is nearly broke asks the channel for a few coins, and colleagues spare 1 or 5 from buttons
// under the plea. `/bank beg 5 for coffee`.
//
// What is spared is an `alms` entry: a gift, but charity rather than thanks, so it doesn't count towards what
// colleagues have given someone. Admins set who counts as nearly broke, how long a plea stays open, and how often
// anyone may beg.
//
// Nobody has to ask for the stimmy check: at the morning round the central bank pays everyone nearly broke a few
// coins out of what it holds, so being at zero is never the end of the game.

import { CENTRAL, CENTS } from "../shared/types"
import { bonded } from "./bonds"
import { brokeLine, say, secureRand, type Line } from "./games"
import { button, inPlace, loud, quiet, tooFast, withButtons, type Ledger, type Message } from "./ledger"
import { money } from "./money"

type Plea = { id: number; user_id: string; target: number; raised: number; reason: string; at: number; closed: number }

const DAY = 24 * 60 * 60_000
/** What the buttons under a plea spare, in coins. */
const SPARE = [1, 5]

const ASKING: Line[] = [
  (w) => `${w.user} is begging for *${w.amount}*${w.reason}. they hold ${w.holds}, and it shows.`,
  (w) => `${w.user} would like *${w.amount}*${w.reason}, and has decided pride is a luxury. they hold ${w.holds}.`,
  (w) => `spare a coin? ${w.user} is asking for *${w.amount}*${w.reason} and holds ${w.holds}. the casino sends its regards.`,
]

const FUNDED: Line[] = [
  (w) => `${w.user} got the *${w.amount}* they begged for, from ${w.donors}. dignity not included.`,
  (w) => `${w.donors} covered ${w.user}'s *${w.amount}*. it will be at the casino within the hour.`,
]

export function setupBegging(sql: SqlStorage) {
  sql.exec(`
    create table if not exists pleas (id integer primary key autoincrement, user_id text not null, target integer not null, raised integer not null default 0, reason text not null default '', channel text, at integer not null, closed integer not null default 0);
    create table if not exists plea_gifts (plea integer not null, user_id text not null, amount integer not null, primary key (plea, user_id));
  `)
}

/** What someone has to their name: coins in bonds or in shares still count, so they aren't broke, just illiquid. */
function worth(ledger: Ledger, user: string, balance: number) {
  const shares = ledger.sql.exec<{ n: number | null }>("select sum(cost) as n from positions where user_id = ?", user).one().n ?? 0
  return balance + bonded(ledger, user) + shares
}

/**
 * The stimmy check, paid in the daily round: everyone nearly broke gets the same from the central bank, poorest
 * first, for as long as its reserves last. Nothing is printed for it, so an empty bank pays nobody.
 */
export function welfare(ledger: Ledger) {
  const rules = ledger.config().begging
  if (!(rules.welfare > 0)) return null
  const broke = ledger.sql
    .exec<{ id: string; balance: number }>("select id, balance from accounts where bot = 0 and gone = 0 and balance < ? order by id", rules.below)
    .toArray()
    .map((row) => ({ id: row.id, worth: worth(ledger, row.id, row.balance) }))
    .filter((row) => row.worth < rules.below)
    .sort((a, b) => a.worth - b.worth)
  if (!broke.length) return null
  const paid = broke.filter((person) => ledger.move({ from: CENTRAL, to: person.id, amount: rules.welfare, kind: "stimulus", note: "stimmy check" }).ok).map((person) => person.id)
  return { paid, missed: broke.length - paid.length, each: rules.welfare }
}

const find = (ledger: Ledger, id: number) => ledger.sql.exec<Plea>("select * from pleas where id = ?", id).toArray()[0] ?? null
const open = (ledger: Ledger, plea: Plea) => !plea.closed && plea.at > Date.now() - ledger.config().begging.minutes * 60_000

/** Who has spared something, by name: a plea is rewritten with every gift, and nobody should be pinged for that. */
const donors = (ledger: Ledger, plea: Plea) =>
  ledger.sql
    .exec<{ user_id: string }>("select user_id from plea_gifts where plea = ? order by amount desc, user_id", plea.id)
    .toArray()
    .map((row) => ledger.row(row.user_id)?.name ?? "someone")

function card(ledger: Ledger, plea: Plea, holds: number): Message {
  const config = ledger.config()
  const coins = (cents: number) => money(config, cents)
  const given = donors(ledger, plea)
  const words = { user: `<@${plea.user_id}>`, amount: coins(plea.target), reason: plea.reason ? ` (${plea.reason})` : "", holds: coins(holds), donors: given.join(", ") }
  if (plea.raised >= plea.target) return loud(`:pleading_face: ${say(secureRand, FUNDED, words)}`)
  const closes = Math.floor((plea.at + config.begging.minutes * 60_000) / 1000)
  const so = plea.raised ? `${coins(plea.raised)} of ${coins(plea.target)} so far, from ${given.join(", ")}.` : "nothing yet."
  const text = `:pleading_face: ${say(secureRand, ASKING, words)}\n${so} open until <!date^${closes}^{time}|in an hour>.`
  return withButtons(loud(text), SPARE.map((amount, index) => button(`Spare ${coins(amount * CENTS)}`, "beg_spare", `${plea.id}:${amount}`, index ? undefined : "primary")))
}

/** Answers `/bank beg`, or returns null when the words aren't about begging. */
export async function beg(ledger: Ledger, input: { sub: string; words: string[]; user: string; channel: string | null }): Promise<Message | null> {
  if (input.sub !== "beg") return null
  const config = ledger.config()
  const rules = config.begging
  const coins = (cents: number) => money(config, cents)
  if (rules.perDay <= 0) return quiet("begging is switched off here. you'll have to earn it, or win it.")
  const row = (await ledger.ensure([input.user])).get(input.user)
  if (!row || row.gone) return quiet("only members of this workspace get to beg here.")
  const holds = worth(ledger, input.user, row.balance)
  if (holds >= rules.below) return quiet(`you hold ${coins(holds)}. begging is for people under ${coins(rules.below)}, and you're not poor enough yet. the casino can fix that.`)
  const mine = ledger.sql.exec<Plea>("select * from pleas where user_id = ? order by id desc limit 1", input.user).toArray()[0]
  if (mine && open(ledger, mine)) return quiet("you're already begging. give them a minute, they're looking for change.")
  const today = ledger.sql.exec<{ n: number }>("select count(*) as n from pleas where user_id = ? and at > ?", input.user, Date.now() - DAY).one().n
  if (today >= rules.perDay) return quiet(`you've begged ${today === 1 ? "once" : `${today} times`} today, which is the limit. try again tomorrow, or try working.`)
  const word = input.words.find((word) => /^\d+(\.\d{1,2})?$/.test(word))
  const target = word ? Math.round(Number(word) * CENTS) : rules.below
  if (target < CENTS) return quiet("beg for at least a coin. `/bank beg 5 for coffee`")
  if (target > rules.below) return quiet(`you can beg for ${coins(rules.below)} at most. aim lower, it suits you.`)
  const reason = input.words
    .filter((word) => word !== word.match(/^\d+(\.\d{1,2})?$/)?.[0])
    .join(" ")
    .replace(/[<>&*_~`|]/g, "")
    .trim()
    .slice(0, 100)
  ledger.sql.exec("insert into pleas (user_id, target, reason, channel, at) values (?, ?, ?, ?, ?)", input.user, target, reason, input.channel, Date.now())
  const plea = ledger.sql.exec<Plea>("select * from pleas where user_id = ? order by id desc limit 1", input.user).one()
  return card(ledger, plea, holds)
}

/** A click on Spare: the coins go straight to the beggar, never past what they asked for. Null when the click isn't one. */
export async function begClick(ledger: Ledger, input: { user: string; action: string; value: string }): Promise<Message | null> {
  if (input.action !== "beg_spare") return null
  const config = ledger.config()
  const [id, amount] = input.value.split(":").map(Number)
  const plea = find(ledger, id ?? 0)
  if (!plea || !open(ledger, plea) || plea.raised >= plea.target) return quiet("that plea has closed. they'll have to find another way to be poor.")
  if (plea.user_id === input.user) return quiet("you can't give to your own plea. that's just holding money.")
  const row = (await ledger.ensure([input.user])).get(input.user)
  if (!row || row.gone) return quiet("only members of this workspace can spare anything here.")
  const spare = Math.min((amount ?? 1) * CENTS, plea.target - plea.raised)
  if (row.balance < spare) return quiet(brokeLine(secureRand, { balance: money(config, row.balance) }))
  if (tooFast(ledger, input.user, ["alms"])) return quiet("slow down. generosity this fast looks like laundering.")
  if (!ledger.move({ from: input.user, to: plea.user_id, amount: spare, kind: "alms", note: plea.reason || null, actor: input.user }).ok) return quiet("something went wrong, try again")
  ledger.sql.exec("update pleas set raised = raised + ?, closed = case when raised + ? >= target then 1 else 0 end where id = ?", spare, spare, plea.id)
  ledger.sql.exec("insert into plea_gifts (plea, user_id, amount) values (?, ?, ?) on conflict (plea, user_id) do update set amount = amount + excluded.amount", plea.id, input.user, spare)
  const holds = worth(ledger, plea.user_id, ledger.row(plea.user_id)?.balance ?? 0)
  return inPlace(card(ledger, find(ledger, plea.id)!, holds))
}

/** The begging part of `/bank help`: nothing while it's switched off. */
export function begHelp(ledger: Ledger) {
  const config = ledger.config()
  const rules = config.begging
  const check = rules.welfare > 0 ? [`*stimmy check* · ${money(config, rules.welfare)} from the central bank at the morning draw, for anyone holding under ${money(config, rules.below)}, while it has any`] : []
  if (rules.perDay <= 0) return check
  return [`*begging* · \`/bank beg 5 for coffee\` · for anyone holding under ${money(config, rules.below)}. colleagues spare a coin or five from the buttons`, ...check]
}
