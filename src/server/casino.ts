// Games, the daily round and the economy figures, as they touch the ledger. The odds and the wording live in
// games.ts, the games with a second step (duels, blackjack, heists) in tables.ts, and office bets in pools.ts.
//
// Nothing here creates or destroys coins. A stake goes to the house or the lottery pot, a win comes back out of them,
// and what the house wins beyond its reserve goes to the central bank, which pays part of it back into each draw.
//
// Like the rest of the ledger this counts in cents, and the settings it is handed are in cents too. The economy
// figures are the one thing that leaves here for the web app, so they go out in coins.

import { BONDS, CENTRAL, CENTS, HOUSE, INSTITUTIONS, MARKET, nextDraw, POOLS, POT, toCents, type Config, type Economy } from "../shared/types"
import { matureBonds } from "./bonds"
import {
  BLACKJACK_TOP,
  brokeLine,
  draw,
  drawLine,
  flip,
  HEIST_PAYS,
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
import { held, loud, quiet, schedule, tooFast, type Ledger, type Message } from "./ledger"
import { money as currency } from "./money"
import { publish } from "./paper"
import { expirePools, pool } from "./pools"
import { answerDuel, deal, hasHand, joinHeist, offerDuel, owed, planHeist, playHand, runHeist } from "./tables"
import { collectWealth, levy, taxed } from "./taxes"
import { award } from "./titles"

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
    create table if not exists bonds (id integer primary key autoincrement, user_id text not null, amount integer not null, rate real not null, matures integer not null);
    create table if not exists heists (id integer primary key autoincrement, by_id text not null, stake integer not null, crew text not null, at integer not null);
    create table if not exists pools (id integer primary key autoincrement, by_id text not null, question text not null, stake integer not null, closed integer not null default 0, channel text, at integer not null);
    create table if not exists pool_bets (pool integer not null, user_id text not null, side text not null, amount integer not null, primary key (pool, user_id));
    create table if not exists titles (user_id text not null, title text not null, at integer not null, primary key (user_id, title));
  `)
  // Marked as bots, which keeps them off the leaderboard and stops anyone giving them coins by hand.
  for (const [id, name] of Object.entries(INSTITUTIONS)) {
    sql.exec("insert or ignore into accounts (id, name, bot, created_at) values (?, ?, 1, ?)", id, name, Date.now())
  }
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
    `\`/bank duel @someone 10\` · a coin flip between you. they \`/bank accept\` or \`/bank decline\`. leave the name out and anyone can take it`,
    `\`/bank heist 10\` · get a crew together to rob the house. ${HEIST_PAYS} times your stake if it works, and a bigger crew has better odds`,
    `\`/bank pool will the demo work?\` · an office bet. people pick yes or no, and whoever called it splits the pot. \`/bank pools\` lists them`,
    `\`/bank lottery 5\` · five tickets for the daily draw. the next one is ${drawTime()}`,
    `\`/bank titles\` · what you've earned, and what's left to earn`,
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
  const to = bet.words.find((word) => MENTION.test(word))?.match(MENTION)![1] ?? null
  if (to === bet.user) return quiet("you can't duel yourself. you'd lose.")
  const problem = await refuse(bet, "say how much, and who if you have someone in mind: `/bank duel @someone 10`, or `/bank duel 10` for anyone")
  if (problem) return quiet(problem)
  const opponent = to ? (await bet.ledger.ensure([to])).get(to) : null
  if (to && (!opponent || opponent.bot || opponent.gone)) return quiet("they can't play. pick on someone who exists.")
  return offerDuel(bet.ledger, { from: bet.user, to, amount: bet.amount })
}

const heist: Game = async (bet) => {
  const word = bet.words[0]?.toLowerCase()
  if (word === "join") return joinHeist(bet.ledger, bet.user)
  if (word === "go") return runHeist(bet.ledger, bet.user)
  const problem = (await refuse(bet, "say what each of the crew puts in: `/bank heist 10`")) ?? tooRich(bet, HEIST_PAYS)
  return problem ? quiet(problem) : planHeist(bet.ledger, bet.user, bet.amount)
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
  ["heist", heist],
  ["pool", (bet) => pool(bet.ledger, bet)],
  ["pools", (bet) => pool(bet.ledger, bet)],
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

// ---------- the daily round

/**
 * The daily round, run from the Workspace's alarm: collects the wealth tax when a week is up, settles the house
 * against its reserve, pays back bonds, calls off office bets nobody settled, draws the lottery if anyone holds a
 * ticket, and hands out titles. What came of it goes out as the morning paper. It comes back the next day by itself
 * for as long as there is anything to come back for.
 */
export async function settle(ledger: Ledger) {
  const config = ledger.config()
  const wealth = collectWealth(ledger)

  const reserve = config.games.reserve
  // What is staked on hands still being played isn't the house's yet.
  const house = held(ledger, HOUSE) - owed(ledger)
  if (house > reserve) {
    ledger.move({ from: HOUSE, to: CENTRAL, amount: house - reserve, kind: "sweep", note: "house winnings" })
  } else if (house < reserve) {
    const refill = Math.min(reserve - house, held(ledger, CENTRAL))
    if (refill > 0) ledger.move({ from: CENTRAL, to: HOUSE, amount: refill, kind: "stimulus", note: "house reserve" })
  }

  const matured = matureBonds(ledger)
  const expired = expirePools(ledger)

  const tickets = ledger.sql.exec<{ user: string; count: number }>("select id as user, count from tickets order by id").toArray()
  const winner = draw(secureRand, tickets)
  let lottery: { winner: string; pot: number; share: string; tax: number } | null = null
  if (winner) {
    const extra = Math.floor((held(ledger, CENTRAL) * LOTTERY_SHARE) / 100)
    if (extra > 0) ledger.move({ from: CENTRAL, to: POT, amount: extra, kind: "stimulus", note: "lottery" })
    const pot = held(ledger, POT)
    if (pot > 0) ledger.move({ from: POT, to: winner, amount: pot, kind: "payout", note: "lottery" })
    ledger.sql.exec("delete from tickets")
    const mine = tickets.find((ticket) => ticket.user === winner)!.count
    // What they paid for their own tickets isn't winnings.
    const tax = levy(ledger, { from: winner, amount: pot - mine * CENTS, rate: config.taxes.winnings, note: "winnings tax", actor: null })
    lottery = { winner, pot, share: `${mine} of ${tickets.reduce((sum, ticket) => sum + ticket.count, 0)}`, tax }
  }

  const posted = await publish(ledger, { wealth, matured, expired, lottery, honours: award(ledger) })
  // Bank can't post where it isn't a member, so a winner the paper didn't reach is told directly.
  if (lottery && !posted) {
    const text = drawLine(secureRand, { winner: `<@${lottery.winner}>`, pot: currency(config, lottery.pot), share: lottery.share }) + taxed(config, lottery.tax)
    await ledger.call("chat.postMessage", { channel: lottery.winner, text, unfurl_links: false }).catch((error: unknown) => console.error("announcement failed", error))
  }

  if (config.games.enabled || config.taxes.wealth > 0 || held(ledger, BONDS) > 0) await ledger.storage.setAlarm(nextDraw(Date.now()))
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
    bonds: held(ledger, BONDS),
    pools: held(ledger, POOLS),
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
      bonds: coins(supply.bonds),
      pools: coins(supply.pools),
      total: coins(supply.people + supply.house + supply.pot + supply.central + supply.market + supply.bonds + supply.pools),
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
