// The casino's table games, the ones with a second step: answering a duel, and blackjack's hit or stand. Each step
// can be a slash command or a button under the message. The buttons need Slack's interactivity switched on for the
// app (see slack-manifest.json); the commands always work.
//
// What is still to be answered is a row: a duel waiting in `duels`, a hand being played in `hands`. A row older than
// ten minutes counts as not there, and whoever removes a row is the one who settles it.

import { HOUSE } from "../shared/types"
import {
  BLACKJACK_PAYS,
  brokeLine,
  dealCard,
  dealerPlays,
  duelDeclinedLine,
  duelDoneLine,
  duelOpenLine,
  handLine,
  handTotal,
  isBlackjack,
  secureRand,
  settleHand,
  showCards,
  type Card,
} from "./games"
import { held, inPlace, loud, quiet, withButtons, type Button, type Ledger, type Message } from "./ledger"
import { money } from "./money"
import { levy, taxed } from "./taxes"

const LASTS = 10 * 60_000
const waitingSince = () => Date.now() - LASTS

const button = (text: string, action: string, value: string, style?: Button["style"]): Button => ({
  type: "button",
  text: { type: "plain_text", text },
  action_id: action,
  value,
  ...(style ? { style } : {}),
})

// ---------- duels

type Duel = { id: number; from_id: string; to_id: string; amount: number; at: number }

/** Challenges someone. Any earlier challenge to the same person is replaced. */
export function offerDuel(ledger: Ledger, duel: { from: string; to: string; amount: number }) {
  ledger.sql.exec("delete from duels where (from_id = ?1 and to_id = ?2) or at < ?3", duel.from, duel.to, waitingSince())
  ledger.sql.exec("insert into duels (from_id, to_id, amount, at) values (?, ?, ?, ?)", duel.from, duel.to, duel.amount, Date.now())
  const id = String(ledger.sql.exec<{ id: number }>("select max(id) as id from duels where from_id = ? and to_id = ?", duel.from, duel.to).one().id)
  const text = duelOpenLine(secureRand, { from: `<@${duel.from}>`, to: `<@${duel.to}>`, amount: money(ledger.config(), duel.amount) })
  return withButtons(loud(text), [button("Accept", "duel_accept", id, "primary"), button("Decline", "duel_decline", id, "danger")])
}

/** Accepts or declines a duel: the one named by `id`, or the latest one waiting for this person. */
export async function answerDuel(ledger: Ledger, user: string, accept: boolean, id: number | null = null): Promise<Message> {
  const config = ledger.config()
  const coins = (cents: number) => money(config, cents)
  const duel = ledger.sql
    .exec<Duel>("select * from duels where to_id = ?1 and at > ?2 and (?3 is null or id = ?3) order by id desc limit 1", user, waitingSince(), id)
    .toArray()[0]
  if (!duel) return quiet("nobody has challenged you. try being more annoying.")
  const [from, me] = [`<@${duel.from_id}>`, `<@${user}>`]
  const gone = quiet("that duel is already settled.")
  // Whoever removes the duel gets to settle it, so two answers arriving together can't both count.
  const close = () => ledger.sql.exec("delete from duels where id = ?", duel.id).rowsWritten === 1
  if (!accept) return close() ? loud(duelDeclinedLine(secureRand, { from, to: me })) : gone

  const rows = await ledger.ensure([duel.from_id, user])
  const mine = rows.get(user)?.balance ?? 0
  if (mine < duel.amount) return quiet(brokeLine(secureRand, { balance: coins(mine) }))
  if ((rows.get(duel.from_id)?.balance ?? 0) < duel.amount) {
    return close() ? loud(`:crossed_swords: ${from} challenged ${me} for *${coins(duel.amount)}* and no longer has it. duel off. embarrassing.`) : gone
  }
  if (!close()) return gone
  const [winner, loser] = (ledger.rand ?? secureRand)(2) ? [duel.from_id, user] : [user, duel.from_id]
  if (!ledger.move({ from: loser, to: winner, amount: duel.amount, kind: "duel", note: "duel", actor: user }).ok) return quiet("something went wrong, try again")
  const tax = levy(ledger, { from: winner, amount: duel.amount, rate: config.taxes.winnings, note: "winnings tax" })
  return loud(duelDoneLine(secureRand, { winner: `<@${winner}>`, loser: `<@${loser}>`, amount: coins(duel.amount) }) + taxed(config, tax))
}

// ---------- blackjack

/** A hand being played. Its stake is already with the house, and `at` is when it was dealt. */
type Hand = { stake: number; player: Card[]; dealer: Card[]; at: number }

function openHand(ledger: Ledger, user: string): Hand | null {
  const row = ledger.sql
    .exec<{ stake: number; player: string; dealer: string; at: number }>("select stake, player, dealer, at from hands where user_id = ? and at >= ?", user, waitingSince())
    .toArray()[0]
  return row ? { ...row, player: JSON.parse(row.player) as Card[], dealer: JSON.parse(row.dealer) as Card[] } : null
}

export const hasHand = (ledger: Ledger, user: string) => openHand(ledger, user) !== null

/** The most the house may still have to pay on hands being played: twice each stake. It isn't the house's to lose or sweep. */
export function owed(ledger: Ledger) {
  return 2 * (ledger.sql.exec<{ n: number | null }>("select sum(stake) as n from hands where at >= ?", waitingSince()).one().n ?? 0)
}

/** Leaves the hand on the table for the next move: one dealer card face down, and buttons that name this hand. */
function keep(ledger: Ledger, user: string, hand: Hand): Message {
  ledger.sql.exec(
    "insert or replace into hands (user_id, stake, player, dealer, at) values (?, ?, ?, ?, ?)",
    user,
    hand.stake,
    JSON.stringify(hand.player),
    JSON.stringify(hand.dealer),
    hand.at,
  )
  const text = `:black_joker: <@${user}> has *${money(ledger.config(), hand.stake)}* on the table\ndealer: ${showCards(hand.dealer.slice(0, 1))} ??\n<@${user}>: ${showCards(hand.player)} (${handTotal(hand.player)})\n\`/bank hit\` or \`/bank stand\``
  const mine = `${user}:${hand.at}`
  return withButtons(loud(text), [button("Hit", "bj_hit", mine, "primary"), button("Stand", "bj_stand", mine)])
}

/** Ends the hand: the dealer plays if there is anything left to beat, and the house pays what the hand is owed. */
function finish(ledger: Ledger, user: string, hand: Hand): Message {
  const config = ledger.config()
  const dealer = handTotal(hand.player) > 21 || isBlackjack(hand.player) ? hand.dealer : dealerPlays(ledger.rand ?? secureRand, hand.dealer)
  const outcome = settleHand(hand.player, dealer)
  // The house keeps enough aside for every open hand (see `owed`), so this is all of it unless someone emptied the house.
  const paid = Math.min(Math.floor(hand.stake * BLACKJACK_PAYS[outcome]), held(ledger, HOUSE))
  ledger.sql.exec("delete from hands where user_id = ?", user)
  if (paid > 0) ledger.move({ from: HOUSE, to: user, amount: paid, kind: "payout", note: "blackjack", actor: user })
  const tax = levy(ledger, { from: user, amount: paid - hand.stake, rate: config.taxes.winnings, note: "winnings tax" })
  const line = handLine(secureRand, outcome, { user: `<@${user}>`, amount: money(config, hand.stake), win: money(config, paid) })
  return loud(
    `:black_joker: dealer: ${showCards(dealer)} (${handTotal(dealer)}) · <@${user}>: ${showCards(hand.player)} (${handTotal(hand.player)})\n${line}${taxed(config, tax)}`,
  )
}

/** Takes the stake, which has been checked, and deals a hand. A natural is over at once. */
export function deal(ledger: Ledger, user: string, stake: number): Message {
  const rand = ledger.rand ?? secureRand
  if (!ledger.move({ from: user, to: HOUSE, amount: stake, kind: "bet", note: "blackjack", actor: user }).ok) return quiet("something went wrong, try again")
  const hand: Hand = { stake, player: [dealCard(rand), dealCard(rand)], dealer: [dealCard(rand), dealCard(rand)], at: Date.now() }
  return isBlackjack(hand.player) ? finish(ledger, user, hand) : keep(ledger, user, hand)
}

export function playHand(ledger: Ledger, user: string, move: "hit" | "stand"): Message {
  const hand = openHand(ledger, user)
  if (!hand) return quiet("you have no hand on the table. `/bank blackjack 10` deals one.")
  if (move === "hit") hand.player.push(dealCard(ledger.rand ?? secureRand))
  // Standing ends it, and so does reaching twenty-one or going over.
  return move === "stand" || handTotal(hand.player) >= 21 ? finish(ledger, user, hand) : keep(ledger, user, hand)
}

// ---------- buttons

/** A click on one of the buttons above. Only the person a button is for can use it. */
export async function interact(ledger: Ledger, input: { user: string; action: string; value: string }): Promise<Message> {
  if (!ledger.config().games.enabled) return quiet("the casino is closed.")
  const [game, move] = input.action.split("_")
  if (game === "bj" && (move === "hit" || move === "stand")) {
    const [owner, at] = input.value.split(":")
    if (owner !== input.user) return quiet("that isn't your hand. deal your own: `/bank blackjack 10`")
    if (openHand(ledger, input.user)?.at !== Number(at)) return quiet("that hand is over.")
    return inPlace(playHand(ledger, input.user, move))
  }
  if (game === "duel" && (move === "accept" || move === "decline")) {
    const id = Number(input.value) || 0
    const duel = ledger.sql.exec<Duel>("select * from duels where id = ?", id).toArray()[0]
    if (!duel) return quiet("that duel is already settled.")
    if (duel.to_id !== input.user) return quiet("this duel isn't yours. start your own: `/bank duel @someone 10`")
    if (duel.at <= waitingSince()) {
      ledger.sql.exec("delete from duels where id = ?", id)
      return inPlace(loud(`:crossed_swords: <@${input.user}> took too long to answer. the duel is off.`))
    }
    const answer = await answerDuel(ledger, input.user, move === "accept", id)
    return answer.response_type === "ephemeral" ? answer : inPlace(answer)
  }
  return quiet("that button doesn't do anything anymore.")
}
