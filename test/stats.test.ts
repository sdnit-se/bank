// The casino's record, worked out from a small history written by hand so every figure can be checked.
import { expect, test } from "bun:test"
import { casinoStats } from "../src/server/stats"
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
})
