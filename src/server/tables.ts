// The casino's table games, the ones with a second step: answering a duel, and blackjack's hit or stand. Each step
// can be a slash command or a button under the message. The buttons need Slack's interactivity switched on for the
// app (see slack-manifest.json); the commands always work.

import { HOUSE } from "../shared/types"
import type { Ledger } from "./casino"
import {
  BLACKJACK_PAYS,
  brokeLine,
  dealCard,
  dealerPlays,
  duelDeclinedLine,
  duelDoneLine,
  handLine,
  handTotal,
  isBlackjack,
  secureRand,
  settleHand,
  showCards,
  type Card,
} from "./games"
import { money } from "./money"
import { levy, taxed } from "./taxes"

type Text = { type: string; text: string }
type Button = { type: "button"; text: Text; action_id: string; value: string; style?: "primary" | "danger" }
type Block = { type: "section"; text: Text } | { type: "actions"; elements: Button[] }

export type Message = {
  response_type: "ephemeral" | "in_channel"
  text: string
  blocks?: Block[]
  /** For an answer to a button: put this in place of the message the button was under. */
  replace_original?: boolean
}

const MINUTE = 60_000
export const DUEL_LASTS = 10 * MINUTE
const HAND_LASTS = 10 * MINUTE

export const quiet = (text: string): Message => ({ response_type: "ephemeral", text })
export const loud = (text: string): Message => ({ response_type: "in_channel", text })

const button = (text: string, action: string, value: string, style?: Button["style"]): Button => ({
  type: "button",
  text: { type: "plain_text", text },
  action_id: action,
  value,
  ...(style ? { style } : {}),
})

const section = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text } })

/** The same message with buttons under it. The text stays as it is for anything that can't show them. */
function withButtons(message: Message, buttons: Button[]): Message {
  return { ...message, blocks: [section(message.text), { type: "actions", elements: buttons }] }
}

/** Puts a message where the one with the buttons was. It carries its own block so the buttons are sure to go. */
function inPlace(message: Message): Message {
  return { ...message, blocks: message.blocks ?? [section(message.text)], replace_original: true }
}

// ---------- duels

export function duelOffer(message: Message, id: number) {
  return withButtons(message, [button("Accept", "duel_accept", String(id), "primary"), button("Decline", "duel_decline", String(id), "danger")])
}

/** Accepts or declines a duel: the one named by `id`, or the latest one waiting for this person. */
export async function answerDuel(ledger: Ledger, user: string, accept: boolean, id?: number): Promise<Message> {
  const config = ledger.config()
  const coins = (cents: number) => money(config, cents)
  const duel = ledger.sql
    .exec<{ id: number; from_id: string; amount: number }>(
      `select id, from_id, amount from duels where to_id = ?1 and at > ?2 ${id === undefined ? "" : "and id = ?3"} order by id desc limit 1`,
      ...(id === undefined ? [user, Date.now() - DUEL_LASTS] : [user, Date.now() - DUEL_LASTS, id]),
    )
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
  const moved = ledger.move({ from: loser, to: winner, amount: duel.amount, kind: "duel", note: "duel", actor: user })
  if (!moved.ok) return quiet("something went wrong, try again")
  const tax = levy(ledger, { from: winner, amount: duel.amount, rate: config.taxes.winnings, note: "winnings tax" })
  return loud(duelDoneLine(secureRand, { winner: `<@${winner}>`, loser: `<@${loser}>`, amount: coins(duel.amount) }) + taxed(config, tax))
}

// ---------- blackjack

type Hand = { stake: number; player: Card[]; dealer: Card[]; at: number }

function openHand(ledger: Ledger, user: string): Hand | null {
  const row = ledger.sql.exec<{ stake: number; player: string; dealer: string; at: number }>("select stake, player, dealer, at from hands where user_id = ?", user).toArray()[0]
  if (!row) return null
  // A hand left lying is forfeited: the stake went to the house when it was dealt.
  if (row.at < Date.now() - HAND_LASTS) {
    ledger.sql.exec("delete from hands where user_id = ?", user)
    return null
  }
  return { stake: row.stake, player: JSON.parse(row.player) as Card[], dealer: JSON.parse(row.dealer) as Card[], at: row.at }
}

/** The table while the hand is still being played: one dealer card face down. */
function table(ledger: Ledger, user: string, hand: Hand): Message {
  const text = `:black_joker: <@${user}> has *${money(ledger.config(), hand.stake)}* on the table\ndealer: ${showCards(hand.dealer.slice(0, 1))} ??\n<@${user}>: ${showCards(hand.player)} (${handTotal(hand.player)})\n\`/bank hit\` or \`/bank stand\``
  // The buttons name the hand they belong to, so an old message can't play a newer hand.
  const mine = `${user}:${hand.at}`
  return withButtons(loud(text), [button("Hit", "bj_hit", mine, "primary"), button("Stand", "bj_stand", mine)])
}

/** Turns the cards over, pays what the hand is owed and clears the table. */
function finish(ledger: Ledger, user: string, hand: Hand): Message {
  const config = ledger.config()
  const dealer = handTotal(hand.player) > 21 || isBlackjack(hand.player) ? hand.dealer : dealerPlays(ledger.rand ?? secureRand, hand.dealer)
  const outcome = settleHand(hand.player, dealer)
  // The house keeps enough aside for every open hand (see `owed`), so this is all of it unless someone emptied the house.
  const paid = Math.min(Math.floor(hand.stake * BLACKJACK_PAYS[outcome]), ledger.row(HOUSE)?.balance ?? 0)
  ledger.sql.exec("delete from hands where user_id = ?", user)
  if (paid > 0) ledger.move({ from: HOUSE, to: user, amount: paid, kind: "payout", note: "blackjack", actor: user })
  const tax = levy(ledger, { from: user, amount: paid - hand.stake, rate: config.taxes.winnings, note: "winnings tax" })
  const line = handLine(secureRand, outcome, { user: `<@${user}>`, amount: money(config, hand.stake), win: money(config, paid) })
  return loud(
    `:black_joker: dealer: ${showCards(dealer)} (${handTotal(dealer)}) · <@${user}>: ${showCards(hand.player)} (${handTotal(hand.player)})\n${line}${taxed(config, tax)}`,
  )
}

export function hasHand(ledger: Ledger, user: string) {
  return openHand(ledger, user) !== null
}

/** The most the house may still have to pay on hands being played: twice each stake. It isn't the house's to lose or sweep. */
export function owed(ledger: Ledger) {
  return 2 * (ledger.sql.exec<{ n: number | null }>("select sum(stake) as n from hands where at >= ?", Date.now() - HAND_LASTS).one().n ?? 0)
}

/** Deals a hand. The stake has been checked and is taken here. */
export function deal(ledger: Ledger, user: string, stake: number): Message {
  const rand = ledger.rand ?? secureRand
  const staked = ledger.move({ from: user, to: "HOUSE", amount: stake, kind: "bet", note: "blackjack", actor: user })
  if (!staked.ok) return quiet("something went wrong, try again")
  const hand: Hand = { stake, player: [dealCard(rand), dealCard(rand)], dealer: [dealCard(rand), dealCard(rand)], at: Date.now() }
  if (isBlackjack(hand.player)) return finish(ledger, user, hand)
  ledger.sql.exec(
    "insert or replace into hands (user_id, stake, player, dealer, at) values (?, ?, ?, ?, ?)",
    user,
    stake,
    JSON.stringify(hand.player),
    JSON.stringify(hand.dealer),
    hand.at,
  )
  return table(ledger, user, hand)
}

export function playHand(ledger: Ledger, user: string, move: "hit" | "stand"): Message {
  const hand = openHand(ledger, user)
  if (!hand) return quiet("you have no hand on the table. `/bank blackjack 10` deals one.")
  if (move === "stand") return finish(ledger, user, hand)
  hand.player.push(dealCard(ledger.rand ?? secureRand))
  // Twenty-one stands by itself, and anything over it is done.
  if (handTotal(hand.player) >= 21) return finish(ledger, user, hand)
  ledger.sql.exec("update hands set player = ? where user_id = ?", JSON.stringify(hand.player), user)
  return table(ledger, user, hand)
}

// ---------- buttons

/** A click on one of the buttons above. Only the person a button is for can use it. */
export async function interact(ledger: Ledger, input: { user: string; action: string; value: string }): Promise<Message> {
  if (!ledger.config().games.enabled) return quiet("the casino is closed.")
  if (input.action === "bj_hit" || input.action === "bj_stand") {
    const [owner, at] = input.value.split(":")
    if (owner !== input.user) return quiet("that isn't your hand. deal your own: `/bank blackjack 10`")
    if (openHand(ledger, input.user)?.at !== Number(at)) return quiet("that hand is over.")
    return inPlace(playHand(ledger, input.user, input.action === "bj_hit" ? "hit" : "stand"))
  }
  if (input.action === "duel_accept" || input.action === "duel_decline") {
    const id = Number(input.value) || 0
    const duel = ledger.sql.exec<{ to_id: string; at: number }>("select to_id, at from duels where id = ?", id).toArray()[0]
    if (!duel) return quiet("that duel is already settled.")
    if (duel.to_id !== input.user) return quiet("this duel isn't yours. start your own: `/bank duel @someone 10`")
    if (duel.at <= Date.now() - DUEL_LASTS) {
      ledger.sql.exec("delete from duels where id = ?", id)
      return inPlace(loud(`:crossed_swords: <@${input.user}> took too long to answer. the duel is off.`))
    }
    const answer = await answerDuel(ledger, input.user, input.action === "duel_accept", id)
    return answer.response_type === "ephemeral" ? answer : inPlace(answer)
  }
  return quiet("that button doesn't do anything anymore.")
}
