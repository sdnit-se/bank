// Office bets: a yes-or-no question about something real, and a pot for whoever called it.
// `/bank pool 10 will the demo work?`
//
// Each click on a side puts the pool's stake on it, and the stakes sit with the bookmaker until the person who asked
// says how it went. They can't bet on their own question. Nobody plays the house here and nothing is taken off the
// top: the whole pot goes to the side that was right, in proportion to what each put in. A question nobody has
// settled after thirty days is called off and everyone gets their stake back.

import { POOLS, toCents } from "../shared/types"
import { brokeLine, say, secureRand, type Line } from "./games"
import { button, defused, held, inPlace, loud, quiet, settledCard, tooFast, withButtons, type Ledger, type Menu, type Message } from "./ledger"
import { money } from "./money"
import { levy, taxed } from "./taxes"

const OPEN_FOR = 30 * 24 * 60 * 60 * 1000
const MOST_OPEN = 3
const USAGE = "ask something with a yes or no answer: `/bank pool will the demo work?`. put a number first to say what a click costs: `/bank pool 10 will the demo work?`"
/** What a click costs when the person asking doesn't say, in cents. */
const USUAL = 500

type Side = "yes" | "no"
type Pool = { id: number; by_id: string; question: string; stake: number; closed: number; channel: string | null; at: number }
type Stake = { user_id: string; side: Side; amount: number }
/** How the person who asked can end it: stop the betting, say which side was right, or call the whole thing off. */
type Ruling = "close" | "off" | Side

const SETTLED: Line[] = [
  (w) => `${w.winners} called it and ${w.take} *${w.up}* of the other side's money. ${w.losers} were wrong, in public, in writing.`,
  (w) => `*${w.up}* from ${w.losers} to ${w.winners}. the losing side paid for the lesson and will learn nothing.`,
  (w) => `${w.winners} ${w.take} *${w.up}* off ${w.losers}, who had a strong feeling about it.`,
]

const find = (ledger: Ledger, id: number) => ledger.sql.exec<Pool>("select * from pools where id = ?", id).toArray()[0] ?? null
const stakes = (ledger: Ledger, id: number) =>
  ledger.sql.exec<Stake>("select user_id, side, amount from pool_bets where pool = ? order by amount desc, user_id", id).toArray()
const list = (ids: string[]) => ids.map((id) => `<@${id}>`).join(", ")

/** The pool as everyone sees it: the question, who is on which side, what each side would pay, and the buttons. */
function card(ledger: Ledger, pool: Pool): Message {
  const coins = (cents: number) => money(ledger.config(), cents)
  const all = stakes(ledger, pool.id)
  const pot = all.reduce((sum, stake) => sum + stake.amount, 0)
  const side = (name: Side) => {
    const on = all.filter((stake) => stake.side === name)
    const total = on.reduce((sum, stake) => sum + stake.amount, 0)
    const label = name === "yes" ? "Yes" : "No"
    if (!total) return `*${label}* · nobody yet`
    return `*${label}* · ${coins(total)} · pays ${Number((pot / total).toFixed(2))}× · ${on.map((stake) => `<@${stake.user_id}> ${coins(stake.amount).split(" ")[0]}`).join(", ")}`
  }
  const text = [
    `:crystal_ball: *${pool.question}*`,
    side("yes"),
    side("no"),
    pool.closed
      ? `office bet #${pool.id} · betting is closed. <@${pool.by_id}> says how it went.`
      : `office bet #${pool.id} by <@${pool.by_id}> · ${coins(pool.stake)} a click, click again to add more`,
  ].join("\n")
  const option = (label: string, ruling: Ruling) => ({ text: { type: "plain_text", text: label }, value: `${pool.id}:${ruling}` })
  const menu: Menu = {
    type: "overflow",
    action_id: "pool_rule",
    options: [...(pool.closed ? [] : [option("Close the betting", "close")]), option("It's a yes", "yes"), option("It's a no", "no"), option("Call it off", "off")],
  }
  const sides = pool.closed ? [] : [button("Yes", "pool_yes", String(pool.id), "primary"), button("No", "pool_no", String(pool.id), "danger")]
  return withButtons(loud(text), [...sides, menu])
}

function open(ledger: Ledger, input: { user: string; channel: string | null; stake: number; question: string }): Message {
  const config = ledger.config()
  if (input.stake <= 0 || input.question.length < 3) return quiet(USAGE)
  if (input.stake > config.games.maxBet) return quiet(`the most a click can cost is ${money(config, config.games.maxBet)}.`)
  const mine = ledger.sql.exec<{ n: number }>("select count(*) as n from pools where by_id = ?", input.user).one().n
  if (mine >= MOST_OPEN) return quiet(`you already have ${MOST_OPEN} questions open. settle one first: \`/bank pools\``)
  ledger.sql.exec("insert into pools (by_id, question, stake, channel, at) values (?, ?, ?, ?, ?)", input.user, input.question, input.stake, input.channel, Date.now())
  // The morning paper goes wherever the bank last had something to announce.
  if (input.channel && !ledger.meta("lottery_channel")) ledger.setMeta("lottery_channel", input.channel)
  return card(ledger, find(ledger, ledger.sql.exec<{ id: number }>("select max(id) as id from pools where by_id = ?", input.user).one().id)!)
}

/** Puts the pool's stake on one side for someone. */
async function back(ledger: Ledger, user: string, id: number, side: Side): Promise<Message> {
  const config = ledger.config()
  // Looked up first: nothing may wait between finding the pool open and putting the stake on it.
  const row = (await ledger.ensure([user])).get(user)
  if (!row || row.gone) return quiet("only members of this workspace get to be wrong here.")
  const pool = find(ledger, id)
  if (!pool) return quiet("that one is settled.")
  if (pool.closed) return quiet("betting on that one is closed.")
  if (pool.by_id === user) return quiet("you asked the question and you'll be the one settling it, so you don't get to bet on it.")
  const mine = stakes(ledger, id).find((stake) => stake.user_id === user)
  if (mine && mine.side !== side) return quiet(`you're already on ${mine.side}. no hedging.`)
  if ((mine?.amount ?? 0) + pool.stake > config.games.maxBet) return quiet(`the most anyone can put on one question is ${money(config, config.games.maxBet)}.`)
  if (row.balance < pool.stake) return quiet(brokeLine(secureRand, { balance: money(config, row.balance) }))
  if (tooFast(ledger, user, ["bet", "duel"])) return quiet("slow down. the question will still be open in a minute.")
  if (!ledger.move({ from: user, to: POOLS, amount: pool.stake, kind: "bet", note: "the office pool", actor: user }).ok) return quiet("something went wrong, try again")
  ledger.sql.exec(
    "insert into pool_bets (pool, user_id, side, amount) values (?, ?, ?, ?) on conflict (pool, user_id) do update set amount = amount + excluded.amount",
    id,
    user,
    side,
    pool.stake,
  )
  return card(ledger, pool)
}

/** Takes the pool off the book and hands every stake back. */
function refund(ledger: Ledger, pool: Pool) {
  for (const stake of stakes(ledger, pool.id)) ledger.move({ from: POOLS, to: stake.user_id, amount: stake.amount, kind: "payout", note: "pool refund" })
  ledger.sql.exec("delete from pool_bets where pool = ?", pool.id)
  ledger.sql.exec("delete from pools where id = ?", pool.id)
}

/** Ends the betting or the pool. Only the person who asked, or an admin, gets to. */
function rule(ledger: Ledger, user: string, id: number, ruling: Ruling): Message {
  const config = ledger.config()
  const pool = find(ledger, id)
  if (!pool) return quiet("that one is settled.")
  if (pool.by_id !== user && !ledger.admin(user)) return quiet(`only <@${pool.by_id}> or an admin can settle this one.`)
  if (ruling === "close") {
    ledger.sql.exec("update pools set closed = 1 where id = ?", id)
    return card(ledger, { ...pool, closed: 1 })
  }
  const all = stakes(ledger, id)
  const winners = all.filter((stake) => stake.side === ruling)
  const title = `:crystal_ball: *${pool.question}*`
  if (ruling === "off" || !winners.length) {
    refund(ledger, pool)
    return loud(`${title}\n${ruling === "off" ? "called off" : `it's a *${ruling}*, and nobody had bet on that`}. everyone gets their stake back.`)
  }
  const pot = all.reduce((sum, stake) => sum + stake.amount, 0)
  const backed = winners.reduce((sum, stake) => sum + stake.amount, 0)
  const shares = winners.map((stake) => Math.floor((pot * stake.amount) / backed))
  // The cents that don't divide go to whoever put the most on it, so the bookmaker is left with nothing.
  shares[0]! += pot - shares.reduce((sum, share) => sum + share, 0)
  ledger.sql.exec("delete from pool_bets where pool = ?", id)
  ledger.sql.exec("delete from pools where id = ?", id)
  let tax = 0
  winners.forEach((stake, index) => {
    ledger.move({ from: POOLS, to: stake.user_id, amount: shares[index]!, kind: "payout", note: "the office pool" })
    tax += levy(ledger, { from: stake.user_id, amount: shares[index]! - stake.amount, rate: config.taxes.winnings, note: "winnings tax", actor: null })
  })
  const losers = list(all.filter((stake) => stake.side !== ruling).map((stake) => stake.user_id))
  const words = { winners: list(winners.map((stake) => stake.user_id)), take: winners.length === 1 ? "takes" : "split", up: money(config, pot - backed), losers }
  const line = losers ? say(secureRand, SETTLED, words) : `${words.winners} called it, and nobody took the other side, so the prize is their own coins back.`
  return loud(`${title} · it's a *${ruling}*.\n${line}${taxed(config, tax)}`)
}

/** Every office bet still open, oldest first. */
export const openPools = (ledger: Ledger) => ledger.sql.exec<Pool>("select * from pools order by id").toArray()

/** Calls off every pool that has been open too long. Returns their questions, for the morning paper. */
export function expirePools(ledger: Ledger, now = Date.now()) {
  const old = ledger.sql.exec<Pool>("select * from pools where at < ?", now - OPEN_FOR).toArray()
  for (const pool of old) refund(ledger, pool)
  return old.map((pool) => pool.question)
}

/** `/bank pool` and `/bank pools`. Every step a button does can be typed too: `/bank pool 3 yes`, `/bank pool 3 no won`. */
export async function pool(ledger: Ledger, input: { user: string; words: string[]; channel: string | null }): Promise<Message> {
  const coins = (cents: number) => money(ledger.config(), cents)
  const [first, second, third] = input.words.map((word) => word.toLowerCase())
  if (first === undefined) {
    const all = openPools(ledger)
    const lines = all.map((pool) => `#${pool.id} · ${pool.question} · \`/bank pool ${pool.id}\``)
    return quiet([`*office bets* · ${coins(held(ledger, POOLS))} riding on ${all.length === 1 ? "one question" : `${all.length} questions`}`, ...lines, USAGE].join("\n"))
  }
  const known = /^\d+$/.test(first) && input.words.length <= 3 ? find(ledger, Number(first)) : null
  if (known && second === undefined) return { ...card(ledger, known), response_type: "ephemeral" }
  if (known && (second === "close" || second === "off")) return rule(ledger, input.user, known.id, second)
  if (known && (second === "yes" || second === "no")) return third === "won" ? rule(ledger, input.user, known.id, second) : back(ledger, input.user, known.id, second)
  const stake = toCents(first)
  const question = defused(input.words.slice(stake === null ? 0 : 1).join(" ")).slice(0, 200)
  return open(ledger, { user: input.user, channel: input.channel, stake: stake ?? Math.min(USUAL, ledger.config().games.maxBet), question })
}

/** A click under a pool. A bet updates the card where it is; a result is posted afresh, since the card may be days up the channel. */
export async function poolClick(ledger: Ledger, input: { user: string; action: string; value: string }): Promise<Message> {
  if (input.action !== "pool_rule") {
    const answer = await back(ledger, input.user, Number(input.value) || 0, input.action === "pool_yes" ? "yes" : "no")
    return answer.response_type === "ephemeral" ? answer : inPlace(answer)
  }
  const [id, ruling] = input.value.split(":") as [string, Ruling]
  const before = find(ledger, Number(id))
  const answer = rule(ledger, input.user, Number(id), ruling)
  if (answer.response_type === "ephemeral" || ruling === "close") return answer.response_type === "ephemeral" ? answer : inPlace(answer)
  return settledCard(ledger, before?.channel ?? null, answer, `:crystal_ball: ~${before?.question ?? "office bet"}~`)
}
