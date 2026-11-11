// Games, the lottery draw and the economy figures, as they touch the ledger. The odds and the wording live in
// games.ts. This is kept out of workspace.ts so that upstream changes there merge without a fight.
//
// Nothing here creates or destroys coins. A stake goes to the house or the lottery pot, a win comes back out of them,
// and what the house wins beyond its reserve goes to the central bank, which pays part of it back into each draw.
//
// Like the rest of the ledger this counts in cents, and the settings it is handed are in cents too. The economy
// figures are the one thing that leaves here for the web app, so they go out in coins.

import { CENTRAL, CENTS, HOUSE, INSTITUTIONS, MARKET, POT, toCents, type Config, type Economy, type EntryKind } from "../shared/types"
import type { Env } from "./env"
import { money as currency } from "./money"
import {
  brokeLine,
  draw,
  drawLine,
  duelDeclinedLine,
  duelDoneLine,
  duelOpenLine,
  flip,
  FLIP_PAYS,
  flipLine,
  nextDraw,
  secureRand,
  SLOT_TOP,
  slotLine,
  spin,
  ticketLine,
  type Side,
} from "./games"

type Row = { id: string; name: string; balance: number; bot: number; gone: number }

type Moved =
  | { ok: true; id: number; from: number | null; to: number | null }
  | { ok: false; reason: "insufficient" | "unknown"; balance: number }

type Message = { response_type: "ephemeral" | "in_channel"; text: string }

/** What the Workspace lends the casino: its tables, its one way of moving coins, and Slack. */
export type Ledger = {
  sql: SqlStorage
  storage: DurableObjectStorage
  env: Env
  config(): Config
  row(id: string): Row | null
  ensure(ids: string[]): Promise<Map<string, Row | null>>
  move(input: { from: string | null; to: string | null; amount: number; kind: EntryKind; note?: string | null; actor?: string | null }): Moved
  meta<T>(key: string): T | null
  setMeta(key: string, value: unknown): void
  call<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>
}

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const DUEL_LASTS = 10 * MINUTE
const BETS_A_MINUTE = 10
/** The share of the central bank's reserves, in percent, that it adds to each lottery draw. */
const LOTTERY_SHARE = 10

const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/

/** The next draw as Slack shows a time: in each reader's own time zone, with UTC for anything that can't. */
function drawTime(now = Date.now()) {
  const at = nextDraw(now)
  return `<!date^${Math.floor(at / 1000)}^{date_short_pretty} at {time}|${new Date(at).toISOString().slice(11, 16)} UTC>`
}
const COMMANDS = new Set(["flip", "slots", "slot", "spin", "duel", "accept", "decline", "lottery", "lotto", "casino", "house"])

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
  `)
  // Marked as bots, which keeps them off the leaderboard and stops anyone giving them coins by hand.
  for (const [id, name] of Object.entries(INSTITUTIONS)) {
    sql.exec("insert or ignore into accounts (id, name, bot, created_at) values (?, ?, 1, ?)", id, name, Date.now())
  }
}

function held(ledger: Ledger, id: string) {
  return ledger.row(id)?.balance ?? 0
}

/** The draw also settles the house, so any bet makes sure one is coming. */
async function schedule(ledger: Ledger) {
  if ((await ledger.storage.getAlarm()) === null) await ledger.storage.setAlarm(nextDraw(Date.now()))
}

// ---------- slash commands

/** The casino's part of `/bank help`: nothing at all while it's closed. */
export function casinoHelp(config: Config) {
  if (!config.games.enabled) return []
  return [
    `*casino* · bets up to ${currency(config, config.games.maxBet)}`,
    `\`/bank flip 10\` · double or nothing, heads unless you say tails`,
    `\`/bank slots 10\` · three reels, up to ${SLOT_TOP} times your stake`,
    `\`/bank duel @someone 10\` · a coin flip between you. they \`/bank accept\` or \`/bank decline\``,
    `\`/bank lottery 5\` · five tickets for the daily draw. the next one is ${drawTime()}`,
    `\`/bank casino\` · what the house and the pot hold`,
  ]
}

export async function play(
  ledger: Ledger,
  input: { sub: string; words: string[]; user: string; channel: string | null },
): Promise<Message | null> {
  if (!COMMANDS.has(input.sub)) return null
  const config = ledger.config()
  const quiet = (text: string): Message => ({ response_type: "ephemeral", text })
  const loud = (text: string): Message => ({ response_type: "in_channel", text })
  if (!config.games.enabled) return quiet(`the casino is closed. an admin can open it at <${ledger.env.PUBLIC_URL}|the bank>.`)

  const coins = (amount: number) => currency(config, amount)
  const me = `<@${input.user}>`
  const word = input.words.find((word) => /^\d+(\.\d{1,2})?$/.test(word))
  const amount = word ? (toCents(word) ?? 0) : 0

  /** Checks a stake against the limit, the player's balance and how fast they're betting. */
  const refuse = async (usage: string) => {
    if (!Number.isSafeInteger(amount) || amount <= 0) return usage
    if (amount > config.games.maxBet) return `the limit is ${coins(config.games.maxBet)} a bet. the house would like you to last longer than that.`
    const row = (await ledger.ensure([input.user])).get(input.user)
    if (!row || row.gone) return "only members of this workspace get to lose money here."
    if (row.balance < amount) return brokeLine(secureRand, { balance: coins(row.balance) })
    const recent = ledger.sql
      .exec<{ n: number }>(
        "select count(*) as n from entries where actor = ? and kind in ('bet', 'duel') and at > ?",
        input.user,
        Date.now() - MINUTE,
      )
      .one().n
    if (recent >= BETS_A_MINUTE) return "slow down. the house will still be here to take your coins in a minute."
    return null
  }

  /** The house only takes a bet it could pay out in full, whatever happens. */
  const tooRich = (top: number) => {
    const house = held(ledger, HOUSE)
    const most = Math.min(config.games.maxBet, Math.floor(house / (top - 1)))
    if (amount <= most) return null
    if (most <= 0) return "the house is broke. somebody actually broke the bank. an admin has to top it up before anyone plays."
    return `the house only has ${coins(house)}, so the most it will take on this is ${coins(most)}. somebody's been winning.`
  }

  if (input.sub === "casino" || input.sub === "house") {
    const tickets = ledger.sql.exec<{ n: number | null }>("select sum(count) as n from tickets").one().n ?? 0
    return quiet(
      [
        ...casinoHelp(config).slice(0, -1),
        `the house holds ${coins(held(ledger, HOUSE))}, the central bank ${coins(held(ledger, CENTRAL))}`,
        `the lottery pot is ${coins(held(ledger, POT))} across ${tickets} ${tickets === 1 ? "ticket" : "tickets"}, drawn ${drawTime()}`,
      ].join("\n"),
    )
  }

  if (input.sub === "flip") {
    const problem = (await refuse("say how much: `/bank flip 10`, or `/bank flip 10 tails`")) ?? tooRich(FLIP_PAYS)
    if (problem) return quiet(problem)
    const call: Side = input.words.some((word) => /^t(ails)?$/i.test(word)) ? "tails" : "heads"
    const staked = ledger.move({ from: input.user, to: HOUSE, amount, kind: "bet", note: "flip", actor: input.user })
    if (!staked.ok) return quiet("something went wrong, try again")
    const result = flip(secureRand, call)
    if (result.won) ledger.move({ from: HOUSE, to: input.user, amount: amount * FLIP_PAYS, kind: "payout", note: "flip", actor: input.user })
    await schedule(ledger)
    return loud(flipLine(secureRand, result, { user: me, call, amount: coins(amount) }))
  }

  if (input.sub === "slots" || input.sub === "slot" || input.sub === "spin") {
    const problem = (await refuse("say how much: `/bank slots 10`")) ?? tooRich(SLOT_TOP)
    if (problem) return quiet(problem)
    const staked = ledger.move({ from: input.user, to: HOUSE, amount, kind: "bet", note: "slots", actor: input.user })
    if (!staked.ok) return quiet("something went wrong, try again")
    const result = spin(secureRand)
    const win = amount * result.pays
    if (win > 0) ledger.move({ from: HOUSE, to: input.user, amount: win, kind: "payout", note: "slots", actor: input.user })
    await schedule(ledger)
    return loud(slotLine(secureRand, result, { user: me, amount: coins(amount), win: coins(win) }))
  }

  if (input.sub === "duel") {
    const to = input.words.find((word) => MENTION.test(word))?.match(MENTION)![1]
    if (!to) return quiet("name your victim: `/bank duel @someone 10`")
    if (to === input.user) return quiet("you can't duel yourself. you'd lose.")
    const problem = await refuse("say how much: `/bank duel @someone 10`")
    if (problem) return quiet(problem)
    const opponent = (await ledger.ensure([to])).get(to)
    if (!opponent || opponent.bot || opponent.gone) return quiet("they can't play. pick on someone who exists.")
    ledger.sql.exec("delete from duels where (from_id = ?1 and to_id = ?2) or at < ?3", input.user, to, Date.now() - DUEL_LASTS)
    ledger.sql.exec("insert into duels (from_id, to_id, amount, at) values (?, ?, ?, ?)", input.user, to, amount, Date.now())
    return loud(duelOpenLine(secureRand, { from: me, to: `<@${to}>`, amount: coins(amount) }))
  }

  if (input.sub === "accept" || input.sub === "decline") {
    const duel = ledger.sql
      .exec<{ id: number; from_id: string; amount: number }>(
        "select id, from_id, amount from duels where to_id = ? and at > ? order by id desc limit 1",
        input.user,
        Date.now() - DUEL_LASTS,
      )
      .toArray()[0]
    if (!duel) return quiet("nobody has challenged you. try being more annoying.")
    const from = `<@${duel.from_id}>`
    if (input.sub === "decline") {
      ledger.sql.exec("delete from duels where id = ?", duel.id)
      return loud(duelDeclinedLine(secureRand, { from, to: me }))
    }
    const rows = await ledger.ensure([duel.from_id, input.user])
    const mine = rows.get(input.user)?.balance ?? 0
    if (mine < duel.amount) return quiet(brokeLine(secureRand, { balance: coins(mine) }))
    if ((rows.get(duel.from_id)?.balance ?? 0) < duel.amount) {
      ledger.sql.exec("delete from duels where id = ?", duel.id)
      return loud(`:crossed_swords: ${from} challenged ${me} for *${coins(duel.amount)}* and no longer has it. duel off. embarrassing.`)
    }
    const [winner, loser] = secureRand(2) ? [duel.from_id, input.user] : [input.user, duel.from_id]
    ledger.sql.exec("delete from duels where id = ?", duel.id)
    const moved = ledger.move({ from: loser, to: winner, amount: duel.amount, kind: "duel", note: "duel", actor: input.user })
    if (!moved.ok) return quiet("something went wrong, try again")
    return loud(duelDoneLine(secureRand, { winner: `<@${winner}>`, loser: `<@${loser}>`, amount: coins(duel.amount) }))
  }

  // lottery
  const count = (id: string) =>
    ledger.sql.exec<{ count: number }>("select count from tickets where id = ?", id).toArray()[0]?.count ?? 0
  const total = () => ledger.sql.exec<{ n: number | null }>("select sum(count) as n from tickets").one().n ?? 0
  if (!word) {
    return quiet(
      `the pot is ${coins(held(ledger, POT))}. you hold ${count(input.user)} of ${total()} tickets. one coin is one ticket: \`/bank lottery 5\`. the draw is ${drawTime()}, and every day at that time.`,
    )
  }
  const problem = await refuse("say how many tickets: `/bank lottery 5`")
  if (problem) return quiet(problem)
  if (amount % CENTS) return quiet("a ticket is one coin, so whole coins only. nobody wins with half a ticket.")
  const tickets = amount / CENTS
  const bought = ledger.move({ from: input.user, to: POT, amount, kind: "bet", note: "lottery", actor: input.user })
  if (!bought.ok) return quiet("something went wrong, try again")
  ledger.sql.exec(
    "insert into tickets (id, count) values (?, ?) on conflict (id) do update set count = count + excluded.count",
    input.user,
    tickets,
  )
  // The draw is announced wherever the last ticket was bought.
  if (input.channel) ledger.setMeta("lottery_channel", input.channel)
  await schedule(ledger)
  return loud(
    `${ticketLine(secureRand, {
      user: me,
      tickets: `${tickets} ${tickets === 1 ? "ticket" : "tickets"}`,
      pot: coins(held(ledger, POT)),
      chance: `${Math.round((count(input.user) / total()) * 100)}%`,
    })} the draw is ${drawTime()}.`,
  )
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
 * Settles the house against its reserve, then draws the lottery if anyone holds a ticket. Runs from the Workspace's
 * alarm, which the next bet sets again.
 */
export async function settle(ledger: Ledger) {
  const config = ledger.config()
  const reserve = config.games.reserve
  const house = held(ledger, HOUSE)
  if (house > reserve) {
    ledger.move({ from: HOUSE, to: CENTRAL, amount: house - reserve, kind: "sweep", note: "house winnings" })
  } else if (house < reserve) {
    const refill = Math.min(reserve - house, held(ledger, CENTRAL))
    if (refill > 0) ledger.move({ from: CENTRAL, to: HOUSE, amount: refill, kind: "stimulus", note: "house reserve" })
  }

  const tickets = ledger.sql.exec<{ user: string; count: number }>("select id as user, count from tickets order by id").toArray()
  const winner = draw(secureRand, tickets)
  if (!winner) return
  const extra = Math.floor((held(ledger, CENTRAL) * LOTTERY_SHARE) / 100)
  if (extra > 0) ledger.move({ from: CENTRAL, to: POT, amount: extra, kind: "stimulus", note: "lottery" })
  const pot = held(ledger, POT)
  if (pot > 0) ledger.move({ from: POT, to: winner, amount: pot, kind: "payout", note: "lottery" })
  ledger.sql.exec("delete from tickets")

  const sold = tickets.reduce((sum, ticket) => sum + ticket.count, 0)
  const text = drawLine(secureRand, {
    winner: `<@${winner}>`,
    pot: currency(config, pot),
    share: `${tickets.find((ticket) => ticket.user === winner)!.count} of ${sold}`,
  })
  const channel = ledger.meta<string>("lottery_channel")
  const post = (channel: string) => ledger.call("chat.postMessage", { channel, text, unfurl_links: false })
  // Bank can't post where it isn't a member, so fall back to telling the winner directly.
  await (channel ? post(channel).catch(() => post(winner)) : post(winner)).catch((error) => console.error("draw announcement failed", error))
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
    .exec<{ day: number; minted: number; burned: number; gifts: number; bets: number }>(
      `select cast(at / ${DAY} as integer) as day,
        sum(case when from_id is null then amount else 0 end) as minted,
        sum(case when to_id is null then amount else 0 end) as burned,
        sum(case when kind in ('give', 'reaction') then amount when kind = 'refund' then -amount else 0 end) as gifts,
        sum(case when kind in ('bet', 'duel') then amount else 0 end) as bets
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
    return { day: new Date((first + index) * DAY).toISOString().slice(0, 10), supply: running, gifts: row?.gifts ?? 0, bets: row?.bets ?? 0 }
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
    richestShare: total > 0 ? active[active.length - 1]! / total : 0,
    gini,
    broke: active.filter((balance) => balance === 0).length,
    days: days.map((day) => ({ day: day.day, supply: coins(day.supply), gifts: coins(day.gifts), bets: coins(day.bets) })),
  }
}
