// The casino's table games, the ones with a second step: answering a duel, blackjack's hit or stand, and getting a
// crew together for a heist. Each step can be a slash command or a button under the message. The buttons need Slack's
// interactivity switched on for the app (see slack-manifest.json); the commands always work.
//
// What is still to be answered is a row: a duel waiting in `duels`, a hand being played in `hands`, a heist being
// planned in `heists`. A row older than ten minutes counts as not there, and whoever removes a row is the one who
// settles it.

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
  HEIST_CREW,
  HEIST_PAYS,
  heistChance,
  heistLine,
  isBlackjack,
  secureRand,
  settleHand,
  showCards,
  type Card,
} from "./games"
import { button, held, inPlace, loud, quiet, withButtons, type Ledger, type Message } from "./ledger"
import { money } from "./money"
import { poolClick } from "./pools"
import { levy, taxed } from "./taxes"

const LASTS = 10 * 60_000
const waitingSince = () => Date.now() - LASTS

// ---------- duels

type Duel = { id: number; from_id: string; to_id: string; amount: number; at: number }
/** Who a duel is for when it is for whoever takes it first. */
const ANYONE = "*"

/** Challenges someone, or anyone when nobody is named. Any earlier challenge to the same person is replaced. */
export function offerDuel(ledger: Ledger, duel: { from: string; to: string | null; amount: number }) {
  const to = duel.to ?? ANYONE
  ledger.sql.exec("delete from duels where (from_id = ?1 and to_id = ?2) or at < ?3", duel.from, to, waitingSince())
  ledger.sql.exec("insert into duels (from_id, to_id, amount, at) values (?, ?, ?, ?)", duel.from, to, duel.amount, Date.now())
  const id = String(ledger.sql.exec<{ id: number }>("select max(id) as id from duels where from_id = ? and to_id = ?", duel.from, to).one().id)
  const text = duelOpenLine(secureRand, { from: `<@${duel.from}>`, to: duel.to ? `<@${duel.to}>` : "", amount: money(ledger.config(), duel.amount) })
  const accept = button("Accept", "duel_accept", id, "primary")
  return withButtons(loud(text), duel.to ? [accept, button("Decline", "duel_decline", id, "danger")] : [accept])
}

/** Accepts or declines a duel: the one named by `id`, or the latest one this person could answer, theirs before an open one. */
export async function answerDuel(ledger: Ledger, user: string, accept: boolean, id: number | null = null): Promise<Message> {
  const config = ledger.config()
  const coins = (cents: number) => money(config, cents)
  const duel = ledger.sql
    .exec<Duel>(
      "select * from duels where (to_id = ?1 or (to_id = ?4 and from_id != ?1)) and at > ?2 and (?3 is null or id = ?3) order by to_id = ?1 desc, id desc limit 1",
      user,
      waitingSince(),
      id,
      ANYONE,
    )
    .toArray()[0]
  if (!duel) return quiet("nobody has challenged you. try being more annoying.")
  if (!accept && duel.to_id === ANYONE) return quiet("that one is open to anyone. you decline it by doing nothing.")
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

// ---------- heists

type Heist = { id: number; by_id: string; stake: number; crew: string[]; at: number }

/** The heist someone is planning or could join: the one named by `id`, or the latest. */
function plannedHeist(ledger: Ledger, where: "id = ?" | "by_id = ?" | "by_id != ?", value: string | number): Heist | null {
  const row = ledger.sql.exec<Omit<Heist, "crew"> & { crew: string }>(`select * from heists where ${where} and at > ? order by id desc limit 1`, value, waitingSince()).toArray()[0]
  return row ? { ...row, crew: JSON.parse(row.crew) as string[] } : null
}

const crewOf = (heist: Heist) => heist.crew.map((id) => `<@${id}>`).join(", ")

function heistCard(ledger: Ledger, heist: Heist): Message {
  const coins = (cents: number) => money(ledger.config(), cents)
  const text = [
    `:moneybag: <@${heist.by_id}> is putting a crew together to rob the house. *${coins(heist.stake)}* each to get in, *${coins(heist.stake * HEIST_PAYS)}* each if it works.`,
    `crew: ${crewOf(heist)} · ${heistChance(heist.crew.length)}% chance, and every pair of hands up to five helps`,
    `\`/bank heist join\` to get in, and <@${heist.by_id}> says \`/bank heist go\`. ten minutes.`,
  ].join("\n")
  return withButtons(loud(text), [button("Join the crew", "heist_join", String(heist.id), "primary"), button("Go", "heist_go", String(heist.id), "danger")])
}

/** What the house can lose, beyond what it already owes on hands being played. A heist is only on while it could pay the whole crew. */
const worthRobbing = (ledger: Ledger, heist: Heist, crew: number) => held(ledger, HOUSE) - owed(ledger) >= (HEIST_PAYS - 1) * heist.stake * crew

/** Starts planning one. The stake has been checked, and nobody pays until the crew goes in. */
export function planHeist(ledger: Ledger, user: string, stake: number): Message {
  ledger.sql.exec("delete from heists where by_id = ? or at < ?", user, waitingSince())
  ledger.sql.exec("insert into heists (by_id, stake, crew, at) values (?, ?, ?, ?)", user, stake, JSON.stringify([user]), Date.now())
  return heistCard(ledger, plannedHeist(ledger, "by_id = ?", user)!)
}

export async function joinHeist(ledger: Ledger, user: string, id: number | null = null): Promise<Message> {
  const row = (await ledger.ensure([user])).get(user)
  if (!row || row.gone || row.bot) return quiet("only members of this workspace get to rob it.")
  const heist = id === null ? plannedHeist(ledger, "by_id != ?", user) : plannedHeist(ledger, "id = ?", id)
  if (!heist) return quiet("nobody is planning a heist. start one: `/bank heist 10`")
  if (heist.crew.includes(user)) return quiet("you're already in the van.")
  if (heist.crew.length >= HEIST_CREW) return quiet("the van is full.")
  if (!worthRobbing(ledger, heist, heist.crew.length + 1)) return quiet("the house doesn't hold enough to be worth robbing with a bigger crew.")
  if (row.balance < heist.stake) return quiet(brokeLine(secureRand, { balance: money(ledger.config(), row.balance) }))
  heist.crew.push(user)
  ledger.sql.exec("update heists set crew = ? where id = ?", JSON.stringify(heist.crew), heist.id)
  return heistCard(ledger, heist)
}

/** The crew goes in: everyone who can still pay puts their stake up, and one roll decides it for all of them. */
export function runHeist(ledger: Ledger, user: string, id: number | null = null): Message {
  const config = ledger.config()
  const heist = id === null ? plannedHeist(ledger, "by_id = ?", user) : plannedHeist(ledger, "id = ?", id)
  if (!heist) return quiet("you aren't planning a heist. start one: `/bank heist 10`")
  if (heist.by_id !== user) return quiet(`only <@${heist.by_id}> gives the word.`)
  // Whoever removes the plan runs it, and from here on nothing waits, so nobody joins or pays twice.
  if (ledger.sql.exec("delete from heists where id = ?", heist.id).rowsWritten !== 1) return quiet("that heist is over.")
  const crew = heist.crew.filter((member) => (ledger.row(member)?.balance ?? 0) >= heist.stake)
  if (!crew.length || !worthRobbing(ledger, heist, crew.length)) {
    return loud(`:moneybag: <@${user}>'s heist is off: ${crew.length ? "the house no longer holds enough to be worth it" : "nobody in the crew could pay their way in"}.`)
  }
  for (const member of crew) ledger.move({ from: member, to: HOUSE, amount: heist.stake, kind: "bet", note: "heist", actor: member })
  const won = (ledger.rand ?? secureRand)(100) < heistChance(crew.length)
  let tax = 0
  if (won) {
    for (const member of crew) {
      ledger.move({ from: HOUSE, to: member, amount: heist.stake * HEIST_PAYS, kind: "payout", note: "heist", actor: member })
      tax += levy(ledger, { from: member, amount: heist.stake * (HEIST_PAYS - 1), rate: config.taxes.winnings, note: "winnings tax" })
    }
  }
  const left = heist.crew.filter((member) => !crew.includes(member)).map((id) => `<@${id}>`)
  const words = {
    crew: crewOf({ ...heist, crew }),
    walk: crew.length === 1 ? "walks" : "walk",
    was: crew.length === 1 ? "was" : "were",
    amount: money(config, heist.stake),
    win: money(config, heist.stake * HEIST_PAYS),
  }
  return loud(`${heistLine(secureRand, won, words)}${left.length ? ` ${left.join(", ")} couldn't pay and stayed in the van.` : ""}${taxed(config, tax)}`)
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
    if (duel.to_id !== input.user && duel.to_id !== ANYONE) return quiet("this duel isn't yours. start your own: `/bank duel @someone 10`")
    if (duel.at <= waitingSince()) {
      ledger.sql.exec("delete from duels where id = ?", id)
      return inPlace(loud(`:crossed_swords: <@${input.user}> took too long to answer. the duel is off.`))
    }
    const answer = await answerDuel(ledger, input.user, move === "accept", id)
    return answer.response_type === "ephemeral" ? answer : inPlace(answer)
  }
  if (game === "heist" && (move === "join" || move === "go")) {
    const id = Number(input.value) || 0
    const answer = await (move === "join" ? joinHeist(ledger, input.user, id) : runHeist(ledger, input.user, id))
    return answer.response_type === "ephemeral" ? answer : inPlace(answer)
  }
  if (game === "pool") return poolClick(ledger, input)
  return quiet("that button doesn't do anything anymore.")
}
