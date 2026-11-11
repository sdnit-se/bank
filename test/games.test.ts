import { expect, test } from "bun:test"
import { nextDraw } from "../src/shared/types"
import { draw, flip, FLIP_PAYS, handTotal, roulette, secureRand, settleHand, SLOT_TIERS, SLOT_TOP, spin, type Rand } from "../src/server/games"

/** The first call returns `first`; later ones walk through their range, so every pick gets exercised. */
function scripted(first: number): Rand {
  let calls = 0
  return (n) => (calls++ === 0 ? first : (first + calls) % n)
}

test("a coin flip wins 49 times in 100, and the edge takes 2", () => {
  const results = Array.from({ length: 100 }, (_, roll) => flip(() => roll, "heads"))
  expect(results.filter((result) => result.won).length).toBe(49)
  expect(results.filter((result) => result.landed === "edge").length).toBe(2)
  expect(results.every((result) => result.won === (result.landed === "heads"))).toBe(true)
  // 49% of flips paying double is 98 back for every 100 staked.
  expect((49 * FLIP_PAYS) / 100).toBe(0.98)
})

test("the slots return exactly 95%", () => {
  expect(SLOT_TIERS.reduce((sum, tier) => sum + tier.chances, 0)).toBe(10_000)
  let paid = 0
  const seen: Record<string, number> = {}
  for (let roll = 0; roll < 10_000; roll++) {
    const result = spin(scripted(roll))
    paid += result.pays
    seen[result.tier] = (seen[result.tier] ?? 0) + 1
    const distinct = new Set(result.reels).size
    expect(distinct).toBe(result.tier === "nothing" ? 3 : result.tier === "pair" ? 2 : 1)
    expect(result.reels.includes("gem")).toBe(result.tier === "jackpot")
  }
  expect(paid / 10_000).toBe(0.95)
  expect(seen).toEqual({ jackpot: 75, triple: 300, pair: 2800, nothing: 6825 })
  expect(Math.max(...SLOT_TIERS.map((tier) => tier.pays))).toBe(SLOT_TOP)
})

test("every lottery ticket is as likely as the next", () => {
  const tickets = [
    { user: "a", count: 1 },
    { user: "b", count: 3 },
  ]
  expect([0, 1, 2, 3].map((roll) => draw(() => roll, tickets))).toEqual(["a", "b", "b", "b"])
  expect(draw(() => 0, [])).toBeNull()
})

test("secureRand stays in range", () => {
  for (let i = 0; i < 2_000; i++) {
    const value = secureRand(7)
    expect(value >= 0 && value < 7 && Number.isInteger(value)).toBe(true)
  }
})

test("roulette returns 36 of every 37 staked, whatever is bet on", () => {
  for (const pocket of ["red", "black", "odd", "even", 0, 17] as const) {
    const spins = Array.from({ length: 37 }, (_, landed) => roulette(() => landed, pocket))
    expect(spins.reduce((sum, spin) => sum + spin.pays, 0)).toBe(36)
    expect(spins[0]!.won).toBe(pocket === 0)
  }
})

test("blackjack hands are counted and settled by the usual rules", () => {
  const cards = (...ranks: number[]) => ranks.map((rank) => ({ rank, suit: 0 }))
  expect([cards(1, 13), cards(1, 1), cards(1, 9, 5), cards(1, 1, 9)].map(handTotal)).toEqual([21, 12, 15, 21])
  expect(settleHand(cards(10, 5, 9), cards(10, 7))).toBe("bust")
  expect(settleHand(cards(1, 13), cards(10, 9))).toBe("blackjack")
  expect(settleHand(cards(1, 13), cards(1, 12))).toBe("push")
  expect(settleHand(cards(10, 5, 6), cards(1, 12))).toBe("lose")
  expect(settleHand(cards(10, 9), cards(10, 6, 9))).toBe("win")
  expect(settleHand(cards(10, 8), cards(10, 8))).toBe("push")
  expect(settleHand(cards(10, 7), cards(10, 8))).toBe("lose")
})

test("the draw is at 09:00 in Stockholm, summer and winter", () => {
  const next = (...at: [number, number, number, number]) => new Date(nextDraw(Date.UTC(...at))).toISOString().slice(0, 16)
  expect(next(2026, 10, 11, 7)).toBe("2026-11-11T08:00")
  expect(next(2026, 10, 11, 8)).toBe("2026-11-12T08:00")
  expect(next(2026, 6, 1, 12)).toBe("2026-07-02T07:00")
  // The night the clocks go forward, the draw is still at nine.
  expect(next(2027, 2, 27, 12)).toBe("2027-03-28T07:00")
})
