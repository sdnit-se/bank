// The casino's record, read straight off the ledger for the stats page. Nothing here is tracked separately: a stake
// is a `bet` entry, a win is the `payout` entry written right after it, and a duel is one `duel` entry.

import { CENTS, HOUSE, POT, type CasinoStats, type Gambler, type Sources } from "../shared/types"
import type { Ledger } from "./ledger"

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** Where one person's coins came from, in cents. See `Sources`. */
export function sources(ledger: Ledger, user: string): Sources {
  const row = ledger.sql
    .exec<Sources & { held: number }>(
      `select
        coalesce(sum(case
          when kind in ('give', 'reaction') and to_id = ?1 then amount
          when kind in ('give', 'reaction') and from_id = ?1 then -amount
          when kind = 'refund' and to_id = ?1 then amount
          when kind = 'refund' and from_id = ?1 then -amount else 0 end), 0) as colleagues,
        coalesce(sum(case
          when kind in ('payout', 'duel') and to_id = ?1 then amount
          when kind in ('bet', 'duel') and from_id = ?1 then -amount else 0 end), 0) as casino,
        coalesce(sum(case
          when kind = 'sell' and to_id = ?1 then amount
          when kind = 'buy' and from_id = ?1 then -amount else 0 end), 0) as market,
        coalesce(sum(case when kind = 'tax' and from_id = ?1 then amount else 0 end), 0) as taxes,
        (select coalesce(sum(cost), 0) from positions where user_id = ?1) as held
      from entries where from_id = ?1 or to_id = ?1`,
      user,
    )
    .one()
  // Coins still sitting in a position are neither made nor lost yet, so they don't count against the market.
  return { colleagues: row.colleagues, casino: row.casino, market: row.market + row.held, taxes: row.taxes }
}

/** Looks people up by id, for putting a name and a face on a figure. */
export function people(ledger: Ledger) {
  const faces = new Map(
    ledger.sql
      .exec<Gambler>("select id, name, image from accounts where bot = 0")
      .toArray()
      .map((row) => [row.id, row]),
  )
  return (id: string): Gambler => faces.get(id) ?? { id, name: id, image: null }
}

export function casinoStats(ledger: Ledger): CasinoStats {
  const coins = (cents: number) => cents / CENTS
  const who = people(ledger)

  // Every stake against the house, with what it paid: the next payout to the same person at the same game. That is
  // the very next entry for most games, and comes when the hand is over in blackjack.
  const plays: { at: number; actor: string; game: string; stake: number; paid: number }[] = []
  const unpaid = new Map<string, (typeof plays)[number]>()
  const moves = ledger.sql.exec<{ at: number; kind: string; actor: string; game: string; amount: number }>(
    "select at, kind, actor, note as game, amount from entries where actor is not null and ((kind = 'bet' and to_id = ?1) or (kind = 'payout' and from_id = ?1)) order by id",
    HOUSE,
  )
  for (const move of moves.toArray()) {
    const key = `${move.actor} ${move.game}`
    if (move.kind === "bet") {
      plays.push({ at: move.at, actor: move.actor, game: move.game, stake: move.amount, paid: 0 })
      unpaid.set(key, plays.at(-1)!)
    } else if (unpaid.has(key)) {
      unpaid.get(key)!.paid = move.amount
      unpaid.delete(key)
    }
  }
  const tickets = ledger.sql
    .exec<{ actor: string; plays: number; staked: number }>(
      "select actor, count(*) as plays, sum(amount) as staked from entries where kind = 'bet' and to_id = ? and actor is not null group by actor",
      POT,
    )
    .toArray()
  const draws = ledger.sql
    .exec<{ at: number; to_id: string; amount: number }>("select at, to_id, amount from entries where kind = 'payout' and from_id = ? order by id", POT)
    .toArray()
  const duels = ledger.sql
    .exec<{ from_id: string; to_id: string; amount: number }>("select from_id, to_id, amount from entries where kind = 'duel'")
    .toArray()

  type Tally = { net: number; staked: number; bets: number; wins: number; streak: number; run: number }
  const tally = new Map<string, Tally>()
  const of = (id: string) => tally.get(id) ?? tally.set(id, { net: 0, staked: 0, bets: 0, wins: 0, streak: 0, run: 0 }).get(id)!
  const games = new Map<string, { game: string; plays: number; staked: number; paid: number; wins: number }>()
  const game = (name: string) => games.get(name) ?? games.set(name, { game: name, plays: 0, staked: 0, paid: 0, wins: 0 }).get(name)!

  let biggest: (typeof plays)[number] | null = null
  let jackpots = 0
  for (const play of plays) {
    const person = of(play.actor)
    const paid = play.paid
    person.bets++
    person.staked += play.stake
    person.net += paid - play.stake
    // A streak is plays in a row that returned nothing.
    person.run = paid > 0 ? 0 : person.run + 1
    person.streak = Math.max(person.streak, person.run)
    if (paid > play.stake) person.wins++
    const row = game(play.game)
    row.plays++
    row.staked += play.stake
    row.paid += paid
    if (paid > play.stake) row.wins++
    if (paid - play.stake > (biggest ? biggest.paid - biggest.stake : 0)) biggest = play
    if (play.game === "slots" && paid === play.stake * 20) jackpots++
  }
  for (const row of tickets) {
    const person = of(row.actor)
    person.bets += row.plays
    person.staked += row.staked
    person.net -= row.staked
    const lottery = game("lottery")
    lottery.plays += row.plays
    lottery.staked += row.staked
  }
  for (const draw of draws) {
    of(draw.to_id).net += draw.amount
    of(draw.to_id).wins++
    const lottery = game("lottery")
    lottery.paid += draw.amount
    lottery.wins++
  }
  for (const duel of duels) {
    of(duel.from_id).net -= duel.amount
    of(duel.to_id).net += duel.amount
    of(duel.to_id).wins++
    for (const id of [duel.from_id, duel.to_id]) {
      of(id).bets++
      of(id).staked += duel.amount
    }
    const row = game("duel")
    row.plays++
    row.staked += duel.amount * 2
    row.paid += duel.amount * 2
    row.wins++
  }

  const house = plays.reduce((sum, play) => sum + play.stake - play.paid, 0)
  const today = Math.floor(Date.now() / DAY)
  const first = today - 29
  const byDay = new Map<number, number>()
  for (const play of plays) byDay.set(Math.floor(play.at / DAY), (byDay.get(Math.floor(play.at / DAY)) ?? 0) + play.stake - play.paid)
  let running = [...byDay].filter(([day]) => day < first).reduce((sum, [, profit]) => sum + profit, 0)
  const days = Array.from({ length: 30 }, (_, index) => {
    running += byDay.get(first + index) ?? 0
    return { day: new Date((first + index) * DAY).toISOString().slice(0, 10), profit: coins(running) }
  })

  // The pot hour by hour: it climbs as tickets are bought and drops to nothing at each draw.
  const flows = ledger.sql
    .exec<{ at: number; change: number }>("select at, case when to_id = ?1 then amount else -amount end as change from entries where to_id = ?1 or from_id = ?1 order by id", POT)
    .toArray()
  const now = Date.now()
  const thisHour = Math.floor(now / HOUR)
  const byHour = new Map<number, number>()
  let held = 0
  for (const flow of flows) {
    const hour = Math.floor(flow.at / HOUR)
    if (hour <= thisHour - 168) held += flow.change
    else byHour.set(hour, (byHour.get(hour) ?? 0) + flow.change)
  }
  const potHours = Array.from({ length: 168 }, (_, index) => {
    const hour = thisHour - 167 + index
    held += byHour.get(hour) ?? 0
    return { at: Math.min((hour + 1) * HOUR, now), pot: coins(held) }
  })

  const sold = ledger.sql.exec<{ n: number | null }>("select sum(count) as n from tickets").one().n ?? 0
  const gifts =
    ledger.sql.exec<{ n: number | null }>("select sum(case when kind = 'refund' then -amount else amount end) as n from entries where kind in ('give', 'reaction', 'refund')").one().n ?? 0
  const order = ["flip", "slots", "roulette", "blackjack", "heist", "lottery", "duel"]
  return {
    staked: coins([...games.values()].reduce((sum, row) => sum + row.staked, 0)),
    bets: [...games.values()].reduce((sum, row) => sum + row.plays, 0),
    houseProfit: coins(house),
    gifts: coins(gifts),
    pot: coins(ledger.row(POT)?.balance ?? 0),
    tickets: sold,
    games: [...games.values()]
      .sort((a, b) => order.indexOf(a.game) - order.indexOf(b.game))
      .map((row) => ({ ...row, staked: coins(row.staked), paid: coins(row.paid) })),
    people: [...tally]
      .map(([id, row]) => ({ ...who(id), net: coins(row.net), staked: coins(row.staked), bets: row.bets, wins: row.wins, streak: row.streak }))
      .sort((a, b) => b.net - a.net || a.name.localeCompare(b.name)),
    biggestWin: biggest ? { ...who(biggest.actor), game: biggest.game, stake: coins(biggest.stake), paid: coins(biggest.paid), at: biggest.at } : null,
    jackpots,
    draws: draws.map((draw) => ({ at: draw.at, pot: coins(draw.amount), winner: who(draw.to_id) })),
    potHours,
    days,
  }
}
