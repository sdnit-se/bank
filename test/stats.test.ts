// The casino's record, worked out from a small history written by hand so every figure can be checked.
import { expect, test } from "bun:test"
import { casinoStats, sources } from "../src/server/stats"
import { CENTS, HOUSE, POT } from "../src/shared/types"
import { A, B, clock, frozen, world } from "./world"

frozen()

test("the stats add up from the ledger", () => {
  const w = world()
  w.print(HOUSE, 500)
  const stake = (user: string, game: string, coins: number, won = 0) => {
    w.ledger.move({ from: user, to: HOUSE, amount: coins * CENTS, kind: "bet", note: game, actor: user })
    if (won) w.ledger.move({ from: HOUSE, to: user, amount: won * CENTS, kind: "payout", note: game, actor: user })
  }
  stake(A, "flip", 10, 20)
  stake(A, "slots", 5)
  stake(A, "slots", 5)
  stake(A, "slots", 1, 20)
  for (let lost = 0; lost < 3; lost++) stake(B, "flip", 10)
  w.ledger.move({ from: A, to: POT, amount: 5 * CENTS, kind: "bet", note: "lottery", actor: A })
  w.ledger.move({ from: B, to: POT, amount: 15 * CENTS, kind: "bet", note: "lottery", actor: B })
  w.ledger.move({ from: POT, to: B, amount: 20 * CENTS, kind: "payout", note: "lottery" })
  w.ledger.move({ from: A, to: B, amount: 20 * CENTS, kind: "duel", note: "duel", actor: B })
  w.give(B, A, 7)

  const stats = casinoStats(w.ledger)
  expect(stats.games).toEqual([
    { game: "flip", plays: 4, staked: 40, paid: 20, wins: 1 },
    { game: "slots", plays: 3, staked: 11, paid: 20, wins: 1 },
    { game: "lottery", plays: 2, staked: 20, paid: 20, wins: 1 },
    { game: "duel", plays: 1, staked: 40, paid: 40, wins: 1 },
  ])
  expect(stats).toMatchObject({ staked: 111, bets: 10, houseProfit: 11, gifts: 7, pot: 0, tickets: 0, jackpots: 1 })
  expect(stats.people.map(({ id, net, staked, bets, wins, streak }) => ({ id, net, staked, bets, wins, streak }))).toEqual([
    { id: B, net: -5, staked: 65, bets: 5, wins: 2, streak: 3 },
    { id: A, net: -6, staked: 46, bets: 6, wins: 2, streak: 2 },
  ])
  expect(stats.biggestWin).toMatchObject({ id: A, game: "slots", stake: 1, paid: 20 })
  expect(stats.draws).toHaveLength(1)
  expect(stats.draws[0]).toMatchObject({ pot: 20, winner: { id: B } })
  expect(stats.days).toHaveLength(30)
  expect(stats.days[29]).toEqual({ day: "2026-11-11", profit: 11 })
  // What the house is up is exactly what it holds beyond what was printed for it.
  expect(w.balance(HOUSE)).toBe(500 + stats.houseProfit)
})

test("an empty casino has nothing to report", () => {
  const stats = casinoStats(world().ledger)
  expect(stats).toMatchObject({ staked: 0, bets: 0, houseProfit: 0, games: [], people: [], biggestWin: null, draws: [], jackpots: 0 })
  expect(stats.potHours).toHaveLength(168)
  expect(stats.potHours.every((hour) => hour.pot === 0)).toBe(true)
})

test("the pot is tracked hour by hour, climbing with tickets and emptying at the draw", () => {
  const w = world()
  const hour = 60 * 60 * 1000
  const start = clock.now // 09:00 UTC
  const pay = (from: string, to: string, coins: number, kind: "bet" | "payout") =>
    w.ledger.move({ from, to, amount: coins * CENTS, kind, note: "lottery", actor: kind === "bet" ? from : null })
  // An old ticket from before the week shown still counts toward what the pot holds.
  clock.now = start - 200 * hour
  pay(A, POT, 2, "bet")
  clock.now = start + 10 * 60 * 1000
  pay(A, POT, 5, "bet")
  clock.now = start + 3.5 * hour
  pay(B, POT, 15, "bet")
  clock.now = start + 5 * hour
  pay(POT, B, 22, "payout")
  clock.now = start + 6 * hour + 10 * 60 * 1000
  pay(A, POT, 3, "bet")

  const { potHours } = casinoStats(w.ledger)
  expect(potHours).toHaveLength(168)
  // The last eight hours: 09, 10, 11 hold 7, the 12 o'clock hour adds 15, 13 holds, the draw at 14 empties it, 15 adds 3.
  expect(potHours.slice(-7).map((point) => point.pot)).toEqual([7, 7, 7, 22, 22, 0, 3])
  expect(potHours[0]!.pot).toBe(2)
  expect(potHours[167]!.at).toBe(clock.now)
  expect(potHours[166]!.at).toBe(start + 6 * hour)
  expect(potHours[167]!.pot).toBe(w.balance(POT))
})

test("what colleagues gave is counted apart from winnings, trades and taxes", () => {
  const w = world()
  w.print(HOUSE, 500)
  const move = (from: string | null, to: string | null, coins: number, kind: Parameters<typeof w.ledger.move>[0]["kind"]) =>
    w.ledger.move({ from, to, amount: coins * CENTS, kind, actor: from })
  w.give(B, A, 12)
  w.give(A, B, 2)
  move(A, HOUSE, 10, "bet")
  move(HOUSE, A, 25, "payout")
  move(B, A, 5, "duel")
  move(A, "MARKET", 30, "buy")
  move(A, "CENTRAL", 0.5, "tax")
  move("MARKET", A, 22, "sell")
  w.db.query("insert into positions (user_id, symbol, units, cost) values (?, 'ERIC-B.ST', 1, ?)").run(A, 10 * CENTS)

  const cents = sources(w.ledger, A)
  // In the market: 30 in, 22 out, 10 still held at cost, so 2 made on what was closed.
  expect({ colleagues: cents.colleagues / CENTS, casino: cents.casino / CENTS, market: cents.market / CENTS, taxes: cents.taxes / CENTS }).toEqual({
    colleagues: 10,
    casino: 20,
    market: 2,
    taxes: 0.5,
  })
  expect(sources(w.ledger, B)).toEqual({ colleagues: -10 * CENTS, casino: -5 * CENTS, market: 0, taxes: 0 })
  expect(sources(w.ledger, "UNOBODY")).toEqual({ colleagues: 0, casino: 0, market: 0, taxes: 0 })
})
