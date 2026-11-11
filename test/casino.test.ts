// Plays the casino against the stand-in ledger in world.ts. What matters most here is that no game creates or
// destroys a coin.
import { expect, test } from "bun:test"
import { economy, play, settle } from "../src/server/casino"
import { nextDraw } from "../src/server/games"
import { CENTRAL, CENTS, HOUSE, POT } from "../src/shared/types"
import { A, B, clock, frozen, world as bare } from "./world"

frozen()

function world(...options: Parameters<typeof bare>) {
  const w = bare(...options)
  const say = (user: string, text: string, channel: string | null = "C1") => {
    const words = text.split(" ")
    return play(w.ledger, { sub: words[0]!, words: words.slice(1), user, channel })
  }
  return { ...w, say }
}

test("the casino is closed unless an admin opens it, and leaves other commands alone", async () => {
  const closed = world({ enabled: false })
  expect((await closed.say(A, "flip 10"))!.text).toContain("the casino is closed")
  expect(await closed.say(A, "give <@UBBB> 10")).toBeNull()
  expect(closed.balance(A)).toBe(100)
})

test("the house only takes a bet it could pay in full", async () => {
  const w = world()
  expect((await w.say(A, "flip 10"))!.text).toContain("the house is broke")
  w.print(HOUSE, 100)
  // Slots can pay 20 times the stake, so 100 coins cover a stake of 5.26 and not a cent more.
  const refused = await w.say(A, "slots 25")
  expect(refused!.response_type).toBe("ephemeral")
  expect(refused!.text).toContain("the most it will take on this is 5.26 coins")
  expect((await w.say(A, "slots 5.27"))!.response_type).toBe("ephemeral")
  expect((await w.say(A, "slots 5.26"))!.response_type).toBe("in_channel")
})

test("bets respect the limit, the player's balance and the pace", async () => {
  const w = world()
  w.print(HOUSE, 500)
  expect((await w.say(A, "flip 26"))!.text).toContain("the limit is 25 coins")
  expect((await w.say(A, "flip"))!.text).toContain("say how much")
  w.give(A, B, 97)
  const broke = await w.say(A, "flip 10")
  expect(broke!.response_type).toBe("ephemeral")
  expect(broke!.text).toContain("3 coins")
  for (let bet = 0; bet < 10; bet++) expect((await w.say(B, "flip 1"))!.response_type).toBe("in_channel")
  expect((await w.say(B, "flip 1"))!.text).toContain("slow down")
  clock.now += 61_000
  expect((await w.say(B, "flip 1"))!.response_type).toBe("in_channel")
})

test("no amount of gambling creates or destroys a coin", async () => {
  const w = world()
  w.print(HOUSE, 500)
  const before = w.total()
  for (let round = 0; round < 400; round++) {
    clock.now += 7_000
    const user = round % 2 ? A : B
    await w.say(user, round % 3 ? "slots 5" : "flip 5 tails")
    expect(w.total()).toBe(before)
    expect(w.lowest()).toBeGreaterThanOrEqual(0)
  }
  await settle(w.ledger)
  expect(w.total()).toBe(before)
  expect(w.balance(HOUSE)).toBeLessThanOrEqual(w.config.games.reserve / CENTS)
})

test("a duel moves the stake from the loser to the winner, once", async () => {
  const w = world()
  expect((await w.say(A, "duel <@UAAA> 20"))!.text).toContain("can't duel yourself")
  expect((await w.say(B, "accept"))!.text).toContain("nobody has challenged you")
  const open = await w.say(A, "duel <@UBBB> 20")
  expect(open!.response_type).toBe("in_channel")
  expect(open!.text).toContain("<@UAAA>")
  expect((await w.say(B, "accept"))!.response_type).toBe("in_channel")
  expect([w.balance(A), w.balance(B)].sort()).toEqual([120, 80])
  expect((await w.say(B, "accept"))!.text).toContain("nobody has challenged you")

  await w.say(A, "duel <@UBBB> 10")
  expect((await w.say(B, "decline"))!.response_type).toBe("in_channel")
  await w.say(A, "duel <@UBBB> 10")
  clock.now += 11 * 60_000
  expect((await w.say(B, "accept"))!.text).toContain("nobody has challenged you")
  expect(w.total()).toBe(200)
})

test("the draw settles the house, tops up the pot from the central bank and pays one winner", async () => {
  const w = world()
  w.print(HOUSE, 620)
  w.print(CENTRAL, 100)
  const before = w.total()
  await w.say(A, "lottery 5", "C9")
  await w.say(B, "lottery 15", "C9")
  expect(w.balance(POT)).toBe(20)
  expect(w.alarm()).toBe(nextDraw(clock.now))

  await settle(w.ledger)
  // The house keeps 500 and hands over 120, and the central bank puts a tenth of its 220 into the pot.
  expect(w.balance(HOUSE)).toBe(500)
  expect(w.balance(CENTRAL)).toBe(198)
  expect(w.balance(POT)).toBe(0)
  expect([w.balance(A), w.balance(B)].sort((a, b) => a - b)).toContainEqual(expect.any(Number))
  expect(w.balance(A) + w.balance(B)).toBe(200 - 20 + 42)
  expect(w.total()).toBe(before)
  expect(w.posts).toHaveLength(1)
  expect(w.posts[0]).toMatchObject({ method: "chat.postMessage", channel: "C9" })
  expect(String(w.posts[0]!.text)).toContain("42 coins")

  // With no tickets left there is nothing to draw, and nothing is announced.
  await settle(w.ledger)
  expect(w.posts).toHaveLength(1)
})

test("the central bank refills a house that lost", async () => {
  const w = world()
  w.print(HOUSE, 300)
  w.print(CENTRAL, 1_000)
  await settle(w.ledger)
  expect(w.balance(HOUSE)).toBe(500)
  expect(w.balance(CENTRAL)).toBe(800)
})

test("the economy adds up", async () => {
  const w = world()
  w.print(HOUSE, 500)
  w.give(A, B, 30)
  await w.say(A, "lottery 10")
  const figures = economy(w.ledger)
  expect(figures.supply).toEqual({ people: 190, house: 500, pot: 10, central: 0, market: 0, total: 700 })
  expect(figures.supply.total).toBe(w.total())
  expect(figures.days).toHaveLength(30)
  expect(figures.days[29]).toEqual({ day: "2026-11-11", supply: 700, gifts: 30, bets: 10 })
  expect(figures.growth).toEqual({ week: 700, month: 700 })
  expect(figures.gdp.week).toBe(30)
  expect(figures.turnover.week).toBe(10)
  expect(figures.members).toBe(2)
  expect(figures.richestShare).toBeCloseTo(130 / 190)
  expect(figures.broke).toBe(0)
})

test("stakes can be to the cent, lottery tickets cannot", async () => {
  const w = world()
  w.print(HOUSE, 500)
  expect((await w.say(A, "flip 0.50"))!.response_type).toBe("in_channel")
  expect([99.5, 100.5]).toContain(w.balance(A))
  expect((await w.say(A, "flip 0.505"))!.text).toContain("say how much")
  expect((await w.say(A, "lottery 2.5"))!.text).toContain("whole coins only")
  expect((await w.say(A, "lottery 2"))!.response_type).toBe("in_channel")
  expect(w.balance(POT)).toBe(2)
  expect(w.total()).toBe(700)
})
