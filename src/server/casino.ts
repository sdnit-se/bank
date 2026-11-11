// Games, the lottery draw and the economy figures, as they touch the ledger. The odds and the wording live in
// games.ts, and the games with a second step (duels, blackjack) in tables.ts.
//
// Nothing here creates or destroys coins. A stake goes to the house or the lottery pot, a win comes back out of them,
// and what the house wins beyond its reserve goes to the central bank, which pays part of it back into each draw.
//
// Like the rest of the ledger this counts in cents, and the settings it is handed are in cents too. The economy
// figures are the one thing that leaves here for the web app, so they go out in coins.

import { CENTRAL, CENTS, HOUSE, INSTITUTIONS, MARKET, nextDraw, POT, toCents, type Config, type Economy } from "../shared/types"
import {
  BLACKJACK_TOP,
  brokeLine,
  draw,
  drawLine,
  flip,
  FLIP_PAYS,
  flipLine,
  parsePocket,
  roulette,
  rouletteLine,
  roulettePays,
  secureRand,
  SLOT_TOP,
  slotLine,
  spin,
  ticketLine,
  type Rand,
  type Side,
} from "./games"
import { held, loud, quiet, tooFast, type Ledger, type Message } from "./ledger"
import { money as currency } from "./money"
import { answerDuel, deal, hasHand, offerDuel, owed, playHand } from "./tables"
import { collectWealth, levy, taxed } from "./taxes"

const DAY = 24 * 60 * 60 * 1000
/** The share of the central bank's reserves, in percent, that it adds to each lottery draw. */
const LOTTERY_SHARE = 10
const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/
const AGAIN = "something went wrong, try again"

export function setup(sql: SqlStorage) {
  sql.exec(`
    create table if not exists duels (
      id integer primary key autoincrement,
      from_id text not null,
      to_id text not null,
      amount integer not null,
      at integer not null
    );
    create table if not exists tickets (id text primary key, count integer not null);
    create table if not exists hands (user_id text primary key, stake integer not null, player text not null, dealer text not null, at integer not null);
  `)
  // Marked as bots, which keeps them off the leaderboard and stops anyone giving them coins by hand.
  for (const [id, name] of Object.entries(INSTITUTIONS)) {
    sql.exec("insert or ignore into accounts (id, name, bot, created_at) values (?, ?, 1, ?)", id, name, Date.now())
  }
}

/** The draw also settles the house and collects the wealth tax, so anything at the casino makes sure one is coming. */
export async function schedule(ledger: Ledger) {
  const next = nextDraw(Date.now())
  if ((await ledger.storage.getAlarm()) !== next) await ledger.storage.setAlarm(next)
}

/** The next draw as Slack shows a time: in each reader's own time zone, with UTC for anything that can't. */
function drawTime(now = Date.now()) {
  const at = nextDraw(now)
  return `<!date^${Math.floor(at / 1000)}^{date_short_pretty} at {time}|${new Date(at).toISOString().slice(11, 16)} UTC>`
}

/** The casino's part of `/bank help`: nothing at all while it's closed. */
export function casinoHelp(config: Config) {
  if (!config.games.enabled) return []
  return [
    `*casino* · bets up to ${currency(config, config.games.maxBet)}`,
    `\`/bank flip 10\` · double or nothing, heads unless you say tails`,
    `\`/bank slots 10\` · three reels, up to ${SLOT_TOP} times your stake`,
    `\`/bank roulette 10 red\` · red, black, odd or even doubles it. a number from 0 to 36 pays 36 times`,
    `\`/bank blackjack 10\` · beat the dealer to 21, then \`/bank hit\` or \`/bank stand\`. walk away for ten minutes and the house keeps it`,
    `\`/bank duel @someone 10\` · a coin flip between you. they \`/bank accept\` or \`/bank decline\``,
    `\`/bank lottery 5\` · five tickets for the daily draw. the next one is ${drawTime()}`,
    `\`/bank casino\` · what the house and the pot hold`,
  ]
}

// ---------- slash commands

/** A casino command from someone, with the stake they typed, if they typed one. */
type Bet = {
  ledger: Ledger
  config: Config
  user: string
  words: string[]
  channel: string | null
  /** The first number in what they typed, and what it comes to in cents. */
  word: string | undefined
  amount: number
  rand: Rand
  coins(cents: number): string
}

type Game = (bet: Bet) => Message | Promise<Message>

/** Why a stake can't be taken, if it can't: it isn't one, it's over the limit, they don't have it, or they're going too fast. */
async function refuse({ ledger, config, user, amount, coins }: Bet, usage: string) {
  if (!Number.isSafeInteger(amount) || amount <= 0) return usage
  if (amount > config.games.maxBet) return `the limit is ${coins(config.games.maxBet)} a bet. the house would like you to last longer than that.`
  const row = (await ledger.ensure([user])).get(user)
  if (!row || row.gone) return "only members of this workspace get to lose money here."
  if (row.balance < amount) return brokeLine(secureRand, { balance: coins(row.balance) })
  if (tooFast(ledger, user, ["bet", "duel"])) return "slow down. the house will still be here to take your coins in a minute."
  return null
}

/** The house only takes a bet it could pay out in full, whatever happens, on top of the hands already being played. */
function tooRich({ ledger, config, amount, coins }: Bet, top: number) {
  const house = Math.max(0, held(ledger, HOUSE) - owed(ledger))
  const most = Math.min(config.games.maxBet, Math.floor(house / (top - 1)))
  if (amount <= most) return null
  if (most <= 0) return "the house is broke. somebody actually broke the bank. an admin has to top it up before anyone plays."
  return `the house only has ${coins(house)}, so the most it will take on this is ${coins(most)}. somebody's been winning.`
}

/**
 * One bet against the house, settled on the spot: the stake goes in, the game is played, and whatever it pays comes
 * straight back out. `top` is the most the game can pay, in stakes.
 */
async function wager(
  bet: Bet,
  game: { name: string; usage: string; top: number; play(): { pays: number; line(words: Record<string, string>): string } },
) {
  const problem = (await refuse(bet, game.usage)) ?? tooRich(bet, game.top)
  if (problem) return quiet(problem)
  const { ledger, config, user, amount, coins } = bet
  if (!ledger.move({ from: user, to: HOUSE, amount, kind: "bet", note: game.name, actor: user }).ok) return quiet(AGAIN)
  const result = game.play()
  const win = amount * result.pays
  if (win > 0) ledger.move({ from: HOUSE, to: user, amount: win, kind: "payout", note: game.name, actor: user })
  const tax = levy(ledger, { from: user, amount: win - amount, rate: config.taxes.winnings, note: "winnings tax" })
  return loud(result.line({ user: `<@${user}>`, amount: coins(amount), win: coins(win) }) + taxed(config, tax))
}

const flipCoin: Game = (bet) => {
  const call: Side = bet.words.some((word) => /^t(ails)?$/i.test(word)) ? "tails" : "heads"
  return wager(bet, {
    name: "flip",
    usage: "say how much: `/bank flip 10`, or `/bank flip 10 tails`",
    top: FLIP_PAYS,
    play() {
      const result = flip(bet.rand, call)
      return { pays: result.won ? FLIP_PAYS : 0, line: (words) => flipLine(secureRand, result, { ...words, call }) }
    },
  })
}

const slots: Game = (bet) =>
  wager(bet, {
    name: "slots",
    usage: "say how much: `/bank slots 10`",
    top: SLOT_TOP,
    play() {
      const result = spin(bet.rand)
      return { pays: result.pays, line: (words) => slotLine(secureRand, result, words) }
    },
  })

const wheel: Game = (bet) => {
  const usage = "say how much and on what: `/bank roulette 10 red`. red, black, odd, even, or a number from 0 to 36."
  // The first number is the stake, so a second one is the pocket.
  const stake = bet.word === undefined ? -1 : bet.words.indexOf(bet.word)
  const pocket = parsePocket(bet.words.find((_, index) => index !== stake))
  if (pocket === null) return quiet(usage)
  return wager(bet, {
    name: "roulette",
    usage,
    top: roulettePays(pocket),
    play() {
      const result = roulette(bet.rand, pocket)
      return { pays: result.pays, line: (words) => rouletteLine(secureRand, result, { ...words, pocket: String(pocket) }) }
    },
  })
}

const blackjack: Game = async (bet) => {
  const problem = await refuse(bet, "say how much: `/bank blackjack 10`")
  if (problem) return quiet(problem)
  if (hasHand(bet.ledger, bet.user)) return quiet("you already have a hand on the table. `/bank hit` or `/bank stand`.")
  const short = tooRich(bet, BLACKJACK_TOP)
  return short ? quiet(short) : deal(bet.ledger, bet.user, bet.amount)
}

const duel: Game = async (bet) => {
  const to = bet.words.find((word) => MENTION.test(word))?.match(MENTION)![1]
  if (!to) return quiet("name your victim: `/bank duel @someone 10`")
  if (to === bet.user) return quiet("you can't duel yourself. you'd lose.")
  const problem = await refuse(bet, "say how much: `/bank duel @someone 10`")
  if (problem) return quiet(problem)
  const opponent = (await bet.ledger.ensure([to])).get(to)
  if (!opponent || opponent.bot || opponent.gone) return quiet("they can't play. pick on someone who exists.")
  return offerDuel(bet.ledger, { from: bet.user, to, amount: bet.amount })
}

const tickets = (ledger: Ledger) => ledger.sql.exec<{ n: number | null }>("select sum(count) as n from tickets").one().n ?? 0

const lottery: Game = async (bet) => {
  const { ledger, user, amount, coins } = bet
  const mine = () => ledger.sql.exec<{ count: number }>("select count from tickets where id = ?", user).toArray()[0]?.count ?? 0
  if (bet.word === undefined) {
    return quiet(
      `the pot is ${coins(held(ledger, POT))}. you hold ${mine()} of ${tickets(ledger)} tickets. one coin is one ticket: \`/bank lottery 5\`. the draw is ${drawTime()}, and every day at that time.`,
    )
  }
  const problem = await refuse(bet, "say how many tickets: `/bank lottery 5`")
  if (problem) return quiet(problem)
  if (amount % CENTS) return quiet("a ticket is one coin, so whole coins only. nobody wins with half a ticket.")
  const bought = amount / CENTS
  if (!ledger.move({ from: user, to: POT, amount, kind: "bet", note: "lottery", actor: user }).ok) return quiet(AGAIN)
  ledger.sql.exec("insert into tickets (id, count) values (?, ?) on conflict (id) do update set count = count + excluded.count", user, bought)
  // The draw is announced wherever the last ticket was bought.
  if (bet.channel) ledger.setMeta("lottery_channel", bet.channel)
  return loud(
    `${ticketLine(secureRand, {
      user: `<@${user}>`,
      tickets: `${bought} ${bought === 1 ? "ticket" : "tickets"}`,
      pot: coins(held(ledger, POT)),
      chance: `${Math.round((mine() / tickets(ledger)) * 100)}%`,
    })} the draw is ${drawTime()}.`,
  )
}

const books: Game = ({ ledger, config, coins }) => {
  const sold = tickets(ledger)
  return quiet(
    [
      ...casinoHelp(config).slice(0, -1),
      `the house holds ${coins(held(ledger, HOUSE))}, the central bank ${coins(held(ledger, CENTRAL))}`,
      `the lottery pot is ${coins(held(ledger, POT))} across ${sold} ${sold === 1 ? "ticket" : "tickets"}, drawn ${drawTime()}`,
    ].join("\n"),
  )
}

/** Every word the casino answers to. A new game is one more line here. */
const GAMES = new Map<string, Game>([
  ["flip", flipCoin],
  ["slots", slots],
  ["slot", slots],
  ["spin", slots],
  ["roulette", wheel],
  ["blackjack", blackjack],
  ["bj", blackjack],
  ["hit", (bet) => playHand(bet.ledger, bet.user, "hit")],
  ["stand", (bet) => playHand(bet.ledger, bet.user, "stand")],
  ["duel", duel],
  ["accept", (bet) => answerDuel(bet.ledger, bet.user, true)],
  ["decline", (bet) => answerDuel(bet.ledger, bet.user, false)],
  ["lottery", lottery],
  ["lotto", lottery],
  ["casino", books],
  ["house", books],
])

/** Answers a casino command, or returns null when the words aren't the casino's. */
export async function play(ledger: Ledger, input: { sub: string; words: string[]; user: string; channel: string | null }): Promise<Message | null> {
  const game = GAMES.get(input.sub)
  if (!game) return null
  const config = ledger.config()
  if (!config.games.enabled) return quiet(`the casino is closed. an admin can open it at <${ledger.env.PUBLIC_URL}|the bank>.`)
  await schedule(ledger)
  const word = input.words.find((word) => /^\d+(\.\d{1,2})?$/.test(word))
  return game({
    ledger,
    config,
    user: input.user,
    words: input.words,
    channel: input.channel,
    word,
    amount: word ? (toCents(word) ?? 0) : 0,
    rand: ledger.rand ?? secureRand,
    coins: (cents) => currency(config, cents),
  })
}

/** How a game entry reads in `/bank history`, or null when the entry isn't one. */
export function historyLine(row: { kind: string; from_id: string | null; to_id: string | null; note: string | null }, user: string, amount: string) {
  if (row.kind === "bet") return `-${amount} on ${row.note === "lottery" ? "lottery tickets" : (row.note ?? "a bet")}`
  if (row.kind === "payout") return `+${amount} won at ${row.note === "lottery" ? "the lottery" : (row.note ?? "the casino")}`
  if (row.kind === "duel") return row.from_id === user ? `-${amount} lost a duel to <@${row.to_id}>` : `+${amount} won a duel against <@${row.from_id}>`
  if (row.kind === "stimulus") return `+${amount} from the central bank`
  return null
}

// ---------- the daily draw

/**
 * The daily round, run from the Workspace's alarm: collects the wealth tax when a week is up, settles the house
 * against its reserve, and draws the lottery if anyone holds a ticket. The next bet sets the alarm again, and so does
 * this while there is a wealth tax to come back for.
 */
export async function settle(ledger: Ledger) {
  const config = ledger.config()
  const channel = ledger.meta<string>("lottery_channel")
  const post = (to: string, text: string) => ledger.call("chat.postMessage", { channel: to, text, unfurl_links: false })
  const quietly = (error: unknown) => console.error("announcement failed", error)

  const wealth = collectWealth(ledger)
  if (wealth && wealth.collected > 0 && channel) {
    const payers = `${wealth.payers} ${wealth.payers === 1 ? "person" : "people"}`
    await post(channel, `:classical_building: the central bank collected *${currency(config, wealth.collected)}* in wealth tax from ${payers}. being rich is expensive.`).catch(quietly)
  }

  const reserve = config.games.reserve
  // What is staked on hands still being played isn't the house's yet.
  const house = held(ledger, HOUSE) - owed(ledger)
  if (house > reserve) {
    ledger.move({ from: HOUSE, to: CENTRAL, amount: house - reserve, kind: "sweep", note: "house winnings" })
  } else if (house < reserve) {
    const refill = Math.min(reserve - house, held(ledger, CENTRAL))
    if (refill > 0) ledger.move({ from: CENTRAL, to: HOUSE, amount: refill, kind: "stimulus", note: "house reserve" })
  }

  const tickets = ledger.sql.exec<{ user: string; count: number }>("select id as user, count from tickets order by id").toArray()
  const winner = draw(secureRand, tickets)
  if (winner) {
    const extra = Math.floor((held(ledger, CENTRAL) * LOTTERY_SHARE) / 100)
    if (extra > 0) ledger.move({ from: CENTRAL, to: POT, amount: extra, kind: "stimulus", note: "lottery" })
    const pot = held(ledger, POT)
    if (pot > 0) ledger.move({ from: POT, to: winner, amount: pot, kind: "payout", note: "lottery" })
    ledger.sql.exec("delete from tickets")
    const mine = tickets.find((ticket) => ticket.user === winner)!.count
    // What they paid for their own tickets isn't winnings.
    const tax = levy(ledger, { from: winner, amount: pot - mine * CENTS, rate: config.taxes.winnings, note: "winnings tax", actor: null })

    const sold = tickets.reduce((sum, ticket) => sum + ticket.count, 0)
    const text = drawLine(secureRand, { winner: `<@${winner}>`, pot: currency(config, pot), share: `${mine} of ${sold}` }) + taxed(config, tax)
    // Bank can't post where it isn't a member, so fall back to telling the winner directly.
    await (channel ? post(channel, text).catch(() => post(winner, text)) : post(winner, text)).catch(quietly)
  }

  if (config.taxes.wealth > 0) await ledger.storage.setAlarm(nextDraw(Date.now()))
}

// ---------- the economy

export function economy(ledger: Ledger): Economy {
  const people = ledger.sql.exec<{ balance: number; gone: number }>("select balance, gone from accounts where bot = 0").toArray()
  const active = people.filter((person) => !person.gone).map((person) => person.balance).sort((a, b) => a - b)
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
  const supply = {
    people: sum(people.map((person) => person.balance)),
    house: held(ledger, HOUSE),
    pot: held(ledger, POT),
    central: held(ledger, CENTRAL),
    market: held(ledger, MARKET),
  }

  // An entry with no sender created coins and one with no recipient destroyed them. Everything else only moved them.
  const rows = ledger.sql
    .exec<{ day: number; minted: number; burned: number; gifts: number; bets: number; taxes: number }>(
      `select cast(at / ${DAY} as integer) as day,
        sum(case when from_id is null then amount else 0 end) as minted,
        sum(case when to_id is null then amount else 0 end) as burned,
        sum(case when kind in ('give', 'reaction') then amount when kind = 'refund' then -amount else 0 end) as gifts,
        sum(case when kind in ('bet', 'duel') then amount else 0 end) as bets,
        sum(case when kind = 'tax' then amount else 0 end) as taxes
      from entries group by day order by day`,
    )
    .toArray()
  const byDay = new Map(rows.map((row) => [row.day, row]))
  const today = Math.floor(Date.now() / DAY)
  const first = today - 29
  const before = sum(rows.filter((row) => row.day < first).map((row) => row.minted - row.burned))
  let running = before
  const days = Array.from({ length: 30 }, (_, index) => {
    const row = byDay.get(first + index)
    running += (row?.minted ?? 0) - (row?.burned ?? 0)
    return { day: new Date((first + index) * DAY).toISOString().slice(0, 10), supply: running, gifts: row?.gifts ?? 0, bets: row?.bets ?? 0, taxes: row?.taxes ?? 0 }
  })
  const week = days.slice(-7)

  const total = sum(active)
  // Gini over sorted balances: how far the spread is from everyone holding the same.
  const gini = total > 0 ? sum(active.map((balance, index) => (2 * index - active.length + 1) * balance)) / (active.length * total) : 0

  const coins = (cents: number) => cents / CENTS
  return {
    supply: {
      people: coins(supply.people),
      house: coins(supply.house),
      pot: coins(supply.pot),
      central: coins(supply.central),
      market: coins(supply.market),
      total: coins(supply.people + supply.house + supply.pot + supply.central + supply.market),
    },
    members: active.length,
    growth: { week: coins(days[29]!.supply - days[22]!.supply), month: coins(days[29]!.supply - before) },
    gdp: { week: coins(sum(week.map((day) => day.gifts))), month: coins(sum(days.map((day) => day.gifts))) },
    turnover: { week: coins(sum(week.map((day) => day.bets))), month: coins(sum(days.map((day) => day.bets))) },
    taxes: { week: coins(sum(week.map((day) => day.taxes))), month: coins(sum(days.map((day) => day.taxes))) },
    richestShare: total > 0 ? active[active.length - 1]! / total : 0,
    gini,
    broke: active.filter((balance) => balance === 0).length,
    days: days.map((day) => ({ day: day.day, supply: coins(day.supply), gifts: coins(day.gifts), bets: coins(day.bets), taxes: coins(day.taxes) })),
  }
}
