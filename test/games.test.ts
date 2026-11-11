import { expect, test } from "bun:test"
import { draw, flip, FLIP_PAYS, nextDraw, secureRand, SLOT_TIERS, SLOT_TOP, spin, type Rand } from "../src/server/games"

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

test("the draw is at the next 14:00 UTC", () => {
  expect(new Date(nextDraw(Date.UTC(2026, 10, 11, 9, 30))).toISOString()).toBe("2026-11-11T14:00:00.000Z")
  expect(new Date(nextDraw(Date.UTC(2026, 10, 11, 14, 0))).toISOString()).toBe("2026-11-12T14:00:00.000Z")
})

test("secureRand stays in range", () => {
  for (let i = 0; i < 2_000; i++) {
    const value = secureRand(7)
    expect(value >= 0 && value < 7 && Number.isInteger(value)).toBe(true)
  }
})
