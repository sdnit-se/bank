// Games of skill between two people: connect four and rock paper scissors, best of three.
// `/bank connect @someone 10`, `/bank rps @someone 10`, and everything after that from the buttons.
//
// A challenge costs nothing until it is accepted. Then both stakes go to the bookmaker and stay there until the game
// is over, so nobody can spend what they are about to lose. The winner gets both, and a draw gives each their own
// back. The house isn't in it at any point.
//
// Whoever is being waited on for more than ten minutes loses on time: the other one clicks again and takes it. The
// daily round does the same for games nobody came back to.

import { POOLS } from "../shared/types"
import { brokeLine, say, secureRand, type Line } from "./games"
import { button, inPlace, loud, quiet, tooFast, WAITS, withButtons, type Ledger, type Message } from "./ledger"
import { money } from "./money"
import { levy, taxed } from "./taxes"

export type MatchGame = "connect" | "rps"
type Match = { id: number; game: MatchGame; a: string; b: string; stake: number; state: string; channel: string | null; started: number; moved: number }
/** Who a challenge is for when it is for whoever takes it first. */
const ANYONE = "*"
const NAME: Record<MatchGame, string> = { connect: "connect four", rps: "rock paper scissors" }

const OPEN: Record<MatchGame, Line[]> = {
  connect: [
    (w) => `${w.from} wants ${w.to} at connect four, *${w.amount}* each. no dice, no dealer, nobody else to blame.`,
    (w) => `${w.from} challenges ${w.to} to connect four for *${w.amount}* each. finally a game here you can lose on merit.`,
  ],
  rps: [
    (w) => `${w.from} challenges ${w.to} to rock paper scissors, best of three, *${w.amount}* each. the office's oldest dispute process, now binding.`,
    (w) => `${w.from} wants ${w.to} at rock paper scissors, best of three, for *${w.amount}* each. everyone thinks they can read people.`,
  ],
}

const WON: Record<MatchGame, Line[]> = {
  connect: [
    (w) => `${w.winner} lined up four against ${w.loser} and takes *${w.amount}*. ${w.loser} was busy admiring their own plan.`,
    (w) => `four in a row for ${w.winner}. ${w.loser} saw it one move too late, which cost *${w.amount}*.`,
    (w) => `${w.winner} beat ${w.loser} at connect four and takes *${w.amount}*. no luck involved, which is worse.`,
  ],
  rps: [
    (w) => `${w.winner} beat ${w.loser} ${w.score} at rock paper scissors and takes *${w.amount}*. ${w.loser} is that easy to read.`,
    (w) => `${w.score} to ${w.winner}, who takes *${w.amount}* off ${w.loser}. three options, and ${w.loser} kept finding the wrong one.`,
  ],
}

const LATE: Line[] = [
  (w) => `${w.loser} kept ${w.winner} waiting at ${w.game}, so ${w.winner} wins on time and takes *${w.amount}*. a meeting, presumably.`,
  (w) => `${w.winner} wins at ${w.game} on time and takes *${w.amount}*. ${w.loser} has not been seen since.`,
]

/** A challenge at one of these games. Any earlier one from the same person at the same game is replaced. */
export function offerMatch(ledger: Ledger, input: { game: MatchGame; from: string; to: string | null; amount: number; channel: string | null }): Message {
  const to = input.to ?? ANYONE
  ledger.sql.exec("delete from matches where started = 0 and ((a = ? and game = ?) or moved < ?)", input.from, input.game, Date.now() - WAITS)
  ledger.sql.exec("insert into matches (game, a, b, stake, channel, moved) values (?, ?, ?, ?, ?, ?)", input.game, input.from, to, input.amount, input.channel, Date.now())
  const id = String(ledger.sql.exec<{ id: number }>("select max(id) as id from matches where a = ? and started = 0", input.from).one().id)
  const text = say(secureRand, OPEN[input.game], { from: `<@${input.from}>`, to: input.to ? `<@${input.to}>` : "anyone", amount: money(ledger.config(), input.amount) })
  const accept = button("Accept", "match_accept", id, "primary")
  return withButtons(loud(`${input.game === "connect" ? ":red_circle:" : ":scissors:"} ${text}`), input.to ? [accept, button("Decline", "match_decline", id, "danger")] : [accept])
}

// ---------- connect four: `state` is the columns played so far, and `a` plays first

const COLUMNS = 7
const ROWS = 6
const DISC = [":red_circle:", ":large_yellow_circle:"]
const NUMBERS = [":one:", ":two:", ":three:", ":four:", ":five:", ":six:", ":seven:"]

/** The board as columns from the bottom up, each disc 0 for `a` and 1 for `b`. */
function columns(moves: string) {
  const board: number[][] = Array.from({ length: COLUMNS }, () => [])
  ;[...moves].forEach((column, index) => board[Number(column)]!.push(index % 2))
  return board
}

/** Whether the disc on top of `column` finished four in a row. */
function four(board: number[][], column: number) {
  const row = board[column]!.length - 1
  const mine = board[column]![row]
  return [[1, 0], [0, 1], [1, 1], [1, -1]].some(([across, up]) => {
    let run = 1
    for (const way of [1, -1]) for (let step = 1; board[column + across! * step * way]?.[row + up! * step * way] === mine; step++) run++
    return run >= 4
  })
}

const drawn = (moves: string) => [...Array(ROWS).keys()].reverse().map((row) => columns(moves).map((column) => (column[row] === undefined ? ":white_circle:" : DISC[column[row]])).join("")).join("\n")

// ---------- rock paper scissors: `state` is the rounds each has won and what each has picked this round

const THROWS = ["rock", "paper", "scissors"] as const
type Throw = (typeof THROWS)[number]
const SIGN: Record<Throw, string> = { rock: ":rock:", paper: ":page_facing_up:", scissors: ":scissors:" }
type Rounds = { won: [number, number]; picks: [Throw | null, Throw | null]; last: string }
const rounds = (match: Match): Rounds => (match.state ? (JSON.parse(match.state) as Rounds) : { won: [0, 0], picks: [null, null], last: "" })

// ---------- both

const players = (match: Match) => [match.a, match.b]
/** Who the game is waiting on: whoever's turn it is, or everyone who hasn't picked this round. */
function waitingOn(match: Match) {
  if (match.game === "connect") return [players(match)[match.state.length % 2]!]
  return players(match).filter((_, index) => !rounds(match).picks[index])
}

/** The game as it stands, with the buttons for the next move. */
function card(ledger: Ledger, match: Match): Message {
  const stake = money(ledger.config(), match.stake)
  const by = `by <!date^${Math.floor((match.moved + WAITS) / 1000)}^{time}|ten minutes from now>, or it's lost on time`
  if (match.game === "connect") {
    const turn = match.state.length % 2
    const text = `${DISC[0]} <@${match.a}> against ${DISC[1]} <@${match.b}> at connect four, *${stake}* each\n${NUMBERS.join("")}\n${drawn(match.state)}\n${DISC[turn]} <@${players(match)[turn]}> to move, ${by}.`
    return withButtons(loud(text), NUMBERS.map((_, column) => button(String(column + 1), `match_move_${column}`, `${match.id}:${column}`)))
  }
  const { won, picks, last } = rounds(match)
  const waiting = waitingOn(match)
  const status = waiting.length === 2 ? "both of you: pick one" : `<@${players(match)[picks[0] ? 0 : 1]}> has picked. <@${waiting[0]}>, your throw`
  const text = `:scissors: <@${match.a}> ${won[0]}–${won[1]} <@${match.b}> at rock paper scissors, first to two, *${stake}* each${last ? `\n${last}` : ""}\n${status}, ${by}.`
  return withButtons(loud(text), THROWS.map((sign) => button(`${sign[0]!.toUpperCase()}${sign.slice(1)}`, `match_pick_${sign}`, `${match.id}:${sign}`)))
}

/** Ends a game and pays it out: both stakes to the winner, or each their own back when there isn't one. */
function finish(ledger: Ledger, match: Match, winner: string | null, lines: Line[], words: Record<string, string> = {}, under = ""): Message {
  const config = ledger.config()
  ledger.sql.exec("delete from matches where id = ?", match.id)
  const again = button("Rematch", "match_again", `${match.game}:${match.a}:${match.b}:${match.stake}`)
  if (!winner) {
    for (const player of players(match)) ledger.move({ from: POOLS, to: player, amount: match.stake, kind: "payout", note: NAME[match.game] })
    return withButtons(loud(say(secureRand, lines, { a: `<@${match.a}>`, b: `<@${match.b}>`, amount: money(config, match.stake), ...words }) + under), [again])
  }
  const loser = winner === match.a ? match.b : match.a
  ledger.move({ from: POOLS, to: winner, amount: match.stake * 2, kind: "payout", note: NAME[match.game], actor: winner })
  // Their own stake coming back isn't winnings.
  const tax = levy(ledger, { from: winner, amount: match.stake, rate: config.taxes.winnings, note: "winnings tax" })
  const text = say(secureRand, lines, { winner: `<@${winner}>`, loser: `<@${loser}>`, amount: money(config, match.stake), game: NAME[match.game], ...words })
  return withButtons(loud(`:trophy: ${text}${taxed(config, tax)}${under}`), [again])
}

const DRAWN: Line[] = [(w) => `:handshake: the board is full and nobody won. ${w.a} and ${w.b} get their *${w.amount}* back. the time is gone for good.`]
const CALLED_OFF: Line[] = [(w) => `:zzz: ${w.a} and ${w.b} both walked away from ${w.game}. each gets their *${w.amount}* back.`]

/** Settles a game whose ten minutes are up: whoever was being waited on loses, and if that is both of them it's off. */
function onTime(ledger: Ledger, match: Match) {
  const waiting = waitingOn(match)
  if (waiting.length > 1) return finish(ledger, match, null, CALLED_OFF, { game: NAME[match.game] })
  return finish(ledger, match, waiting[0] === match.a ? match.b : match.a, LATE)
}

/** Takes both stakes and starts the game. Who moves first at connect four is a coin flip. */
async function accept(ledger: Ledger, match: Match, user: string): Promise<Message> {
  const config = ledger.config()
  const rows = await ledger.ensure([match.a, user])
  const mine = rows.get(user)
  if (!mine || mine.bot || mine.gone) return quiet("only members of this workspace get to play here.")
  if (mine.balance < match.stake) return quiet(brokeLine(secureRand, { balance: money(config, mine.balance) }))
  const [a, b] = match.game === "connect" && secureRand(2) ? [user, match.a] : [match.a, user]
  // Whoever starts the game is the one who takes the stakes, so two answers arriving together can't both count.
  const claimed = () => ledger.sql.exec("update matches set a = ?, b = ?, started = 1, moved = ? where id = ? and started = 0", a, b, Date.now(), match.id).rowsWritten === 1
  const off = (text: string) => (ledger.sql.exec("delete from matches where id = ? and started = 0", match.id).rowsWritten === 1 ? inPlace(loud(text)) : quiet("that game has already started."))
  if ((rows.get(match.a)?.balance ?? 0) < match.stake) return off(`<@${match.a}> challenged <@${user}> for *${money(config, match.stake)}* and no longer has it. game off. embarrassing.`)
  if (!claimed()) return quiet("that game has already started.")
  const paid = [a, b].filter((player) => ledger.move({ from: player, to: POOLS, amount: match.stake, kind: "bet", note: NAME[match.game], actor: player }).ok)
  if (paid.length < 2) {
    for (const player of paid) ledger.move({ from: POOLS, to: player, amount: match.stake, kind: "payout", note: NAME[match.game] })
    ledger.sql.exec("delete from matches where id = ?", match.id)
    return quiet("something went wrong, try again")
  }
  return inPlace(card(ledger, { ...match, a, b, started: 1, moved: Date.now() }))
}

/** A click on Rematch: a fresh challenge to the other one, for the same stake. */
async function again(ledger: Ledger, user: string, value: string): Promise<Message> {
  const [game, first, second, stake] = value.split(":")
  if (user !== first && user !== second) return quiet("that was their game. start your own: `/bank connect @someone 10`")
  const other = user === first ? second! : first!
  const amount = Math.min(Number(stake), ledger.config().games.maxBet)
  const rows = await ledger.ensure([user, other])
  if ((rows.get(user)?.balance ?? 0) < amount) return quiet(brokeLine(secureRand, { balance: money(ledger.config(), rows.get(user)?.balance ?? 0) }))
  if (!rows.get(other) || rows.get(other)!.gone) return quiet("they've left. you win by default, which pays nothing.")
  if (tooFast(ledger, user, ["bet", "duel"])) return quiet("slow down. they'll still be there in a minute.")
  return offerMatch(ledger, { game: game === "rps" ? "rps" : "connect", from: user, to: other, amount, channel: null })
}

/** A click on one of these games' buttons, or null when the click is for something else. */
export async function matchClick(ledger: Ledger, input: { user: string; action: string; value: string }): Promise<Message | null> {
  const [family, verb, what] = input.action.split("_")
  if (family !== "match") return null
  if (!ledger.config().games.enabled) return quiet("the casino is closed.")
  if (verb === "again") return again(ledger, input.user, input.value)
  const match = ledger.sql.exec<Match>("select * from matches where id = ?", Number(input.value.split(":")[0]) || 0).toArray()[0]
  if (!match) return quiet("that game is over.")
  const late = match.moved <= Date.now() - WAITS

  if (!match.started) {
    if (verb !== "accept" && verb !== "decline") return quiet("that game hasn't started.")
    if (match.a === input.user || (match.b !== input.user && match.b !== ANYONE)) return quiet(`this one isn't yours. start your own: \`/bank ${match.game} @someone 10\``)
    if (late || verb === "decline") {
      ledger.sql.exec("delete from matches where id = ?", match.id)
      return inPlace(loud(late ? `:hourglass: <@${input.user}> took too long to answer. the game is off.` : `:chicken: <@${input.user}> declined <@${match.a}>'s ${NAME[match.game]}. the coins are safe. the reputation is not.`))
    }
    return accept(ledger, match, input.user)
  }

  // From here on nothing waits on Slack, so a click is read and settled in one go.
  const me = players(match).indexOf(input.user)
  if (me < 0) return quiet(`that's their game. start your own: \`/bank ${match.game} @someone 10\``)
  const waiting = waitingOn(match)
  if (late && !waiting.includes(input.user)) return inPlace(onTime(ledger, match))
  if (!waiting.includes(input.user)) return quiet(match.game === "connect" ? "not your turn. if they haven't moved when the time on the board is up, click again and it's yours." : "you've picked. if they haven't when the time is up, click again and it's yours.")

  if (match.game === "connect" && verb === "move") {
    const column = Number(what)
    const board = columns(match.state)
    if (!board[column] || board[column].length >= ROWS) return quiet("that column is full.")
    const state = match.state + column
    board[column].push(me)
    if (four(board, column)) return inPlace(finish(ledger, match, input.user, WON.connect, {}, `\n${drawn(state)}`))
    if (state.length === COLUMNS * ROWS) return inPlace(finish(ledger, match, null, DRAWN, {}, `\n${drawn(state)}`))
    ledger.sql.exec("update matches set state = ?, moved = ? where id = ?", state, Date.now(), match.id)
    return inPlace(card(ledger, { ...match, state, moved: Date.now() }))
  }

  if (match.game === "rps" && verb === "pick" && THROWS.includes(what as Throw)) {
    const game = rounds(match)
    game.picks[me] = what as Throw
    const [mine, theirs] = [game.picks[me]!, game.picks[1 - me]]
    if (theirs) {
      const beat = (THROWS.indexOf(mine) - THROWS.indexOf(theirs) + 3) % 3
      if (beat === 0) game.last = `both threw ${SIGN[mine]}. again.`
      else {
        const winner = beat === 1 ? me : 1 - me
        game.won[winner]++
        game.last = `${SIGN[game.picks[winner]!]} beats ${SIGN[game.picks[1 - winner]!]}: that round to <@${players(match)[winner]}>.`
        if (game.won[winner] === 2) return inPlace(finish(ledger, match, players(match)[winner]!, WON.rps, { score: `${game.won[winner]}–${game.won[1 - winner]}` }))
      }
      game.picks = [null, null]
    }
    const state = JSON.stringify(game)
    ledger.sql.exec("update matches set state = ?, moved = ? where id = ?", state, Date.now(), match.id)
    return inPlace(card(ledger, { ...match, state, moved: Date.now() }))
  }
  return quiet("that button doesn't do anything anymore.")
}

/**
 * The daily round's part: games left waiting are settled on time and said where they were played, and challenges
 * nobody answered are dropped.
 */
export async function matchesDue(ledger: Ledger) {
  ledger.sql.exec("delete from matches where started = 0 and moved < ?", Date.now() - WAITS)
  for (const match of ledger.sql.exec<Match>("select * from matches where started = 1 and moved <= ?", Date.now() - WAITS).toArray()) {
    const answer = onTime(ledger, match)
    if (match.channel) await ledger.call("chat.postMessage", { channel: match.channel, text: answer.text, unfurl_links: false }).catch((error: unknown) => console.error("match result failed", error))
  }
}
