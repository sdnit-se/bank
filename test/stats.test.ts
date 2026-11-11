// The casino's record, worked out from a small history written by hand so every figure can be checked.
import { expect, test } from "bun:test"
import { casinoStats, sources } from "../src/server/stats"
import { CENTS, HOUSE, POT } from "../src/shared/types"
import { A, B, frozen, world } from "./world"

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
  // A blackjack hand is paid when it is over, by which time other bets have been written.
  stake(B, "blackjack", 10)
  stake(A, "slots", 1)
  w.ledger.move({ from: HOUSE, to: B, amount: 20 * CENTS, kind: "payout", note: "blackjack", actor: B })
  w.ledger.move({ from: A, to: POT, amount: 5 * CENTS, kind: "bet", note: "lottery", actor: A })
  w.ledger.move({ from: B, to: POT, amount: 15 * CENTS, kind: "bet", note: "lottery", actor: B })
  w.ledger.move({ from: POT, to: B, amount: 20 * CENTS, kind: "payout", note: "lottery" })
  w.ledger.move({ from: A, to: B, amount: 20 * CENTS, kind: "duel", note: "duel", actor: B })
  w.give(B, A, 7)

  const stats = casinoStats(w.ledger)
  expect(stats.games).toEqual([
    { game: "flip", plays: 4, staked: 40, paid: 20, wins: 1 },
    { game: "slots", plays: 4, staked: 12, paid: 20, wins: 1 },
    { game: "blackjack", plays: 1, staked: 10, paid: 20, wins: 1 },
    { game: "lottery", plays: 2, staked: 20, paid: 20, wins: 1 },
    { game: "duel", plays: 1, staked: 40, paid: 40, wins: 1 },
  ])
  expect(stats).toMatchObject({ staked: 122, bets: 12, houseProfit: 2, gifts: 7, pot: 0, tickets: 0, jackpots: 1 })
  expect(stats.people.map(({ id, net, staked, bets, wins, streak }) => ({ id, net, staked, bets, wins, streak }))).toEqual([
    { id: B, net: 5, staked: 75, bets: 6, wins: 3, streak: 3 },
    { id: A, net: -7, staked: 47, bets: 7, wins: 2, streak: 2 },
  ])
  expect(stats.biggestWin).toMatchObject({ id: A, game: "slots", stake: 1, paid: 20 })
  expect(stats.draws).toHaveLength(1)
  expect(stats.draws[0]).toMatchObject({ pot: 20, winner: { id: B } })
  expect(stats.days).toHaveLength(30)
  expect(stats.days[29]).toEqual({ day: "2026-11-11", profit: 2 })
  // What the house is up is exactly what it holds beyond what was printed for it.
  expect(w.balance(HOUSE)).toBe(500 + stats.houseProfit)
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
