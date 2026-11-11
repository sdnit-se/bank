// Plays the casino against the stand-in ledger in world.ts. What matters most here is that no game creates or
// destroys a coin.
import { expect, test } from "bun:test"
import { play, settle } from "../src/server/casino"
import { nextDraw, type Rand } from "../src/server/games"
import { interact, type Message } from "../src/server/tables"
import { CENTRAL, CENTS, HOUSE, POT } from "../src/shared/types"
import { A, B, clock, frozen, world as bare } from "./world"

frozen()

function world(...options: Parameters<typeof bare>) {
  const w = bare(...options)
  const say = (user: string, text: string, channel: string | null = "C1") => {
    const words = text.split(" ")
    return play(w.ledger, { sub: words[0]!, words: words.slice(1), user, channel })
  }
  /** Deals these ranks in order, two to the player and then two to the dealer. Anything else random comes up 0. */
  const deck = (...ranks: number[]) => void (w.ledger.rand = ((n) => (n === 13 ? (ranks.shift() ?? 10) - 1 : 0)) as Rand)
  const click = (user: string, action: string, value: string) => interact(w.ledger, { user, action, value })
  return { ...w, say, deck, click }
}

/** What the first button under a message carries. */
function button(message: Message | null) {
  const actions = message?.blocks?.[1]
  return actions?.type === "actions" ? actions.elements[0]!.value : ""
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
    // Each of them comes round to these in turn, so a hand is dealt, hit and stood on.
    await w.say(user, ["blackjack 5", "flip 5 tails", "hit", "slots 5", "stand", "roulette 5 red", "roulette 1 17"][round % 7]!)
    expect(w.total()).toBe(before)
    expect(w.lowest()).toBeGreaterThanOrEqual(0)
  }
  for (const user of [A, B]) await w.say(user, "stand")
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

test("blackjack pays three to two on a natural, double on a win, the stake on a push, and nothing otherwise", async () => {
  const w = world()
  w.print(HOUSE, 500)
  const hand = async (ranks: number[], moves: string[]) => {
    w.deck(...ranks)
    await w.say(A, "blackjack 10")
    for (const move of moves) await w.say(A, move)
    return w.balance(A)
  }
  expect(await hand([1, 13, 10, 9], [])).toBe(115)
  expect(await hand([10, 9, 10, 7], ["stand"])).toBe(125)
  expect(await hand([10, 8, 10, 8], ["stand"])).toBe(125)
  expect(await hand([10, 6, 10, 7, 10], ["hit"])).toBe(115)
  // The dealer has 16 and has to draw, and draws a five.
  expect(await hand([10, 6, 10, 6, 5], ["stand"])).toBe(105)
  expect((await w.say(A, "hit"))!.text).toContain("you have no hand")
  expect(w.total()).toBe(700)
})

test("what a hand could still win is kept aside until it is played, and an abandoned hand is the house's", async () => {
  const w = world({ reserve: 0 })
  w.print(HOUSE, 30)
  w.deck(10, 9, 10, 7)
  await w.say(A, "blackjack 20")
  expect((await w.say(A, "blackjack 5"))!.text).toContain("already have a hand")
  // The house holds 50 and may owe 40 of it, so it can only take 10 on a flip, and only sweeps 10.
  expect((await w.say(B, "flip 25"))!.text).toContain("the most it will take on this is 10 coins")
  await settle(w.ledger)
  expect([w.balance(HOUSE), w.balance(CENTRAL)]).toEqual([40, 10])
  await w.say(A, "stand")
  expect([w.balance(A), w.balance(HOUSE)]).toEqual([120, 0])

  w.print(HOUSE, 30)
  await w.say(A, "blackjack 20")
  clock.now += 11 * 60_000
  expect((await w.say(A, "stand"))!.text).toContain("you have no hand")
  expect([w.balance(A), w.balance(HOUSE)]).toEqual([100, 50])
})

test("a button works for the person it is for, and only once", async () => {
  const w = world()
  w.print(HOUSE, 500)
  const duel = button(await w.say(A, "duel <@UBBB> 20"))
  expect((await w.click(A, "duel_accept", duel)).text).toContain("isn't yours")
  // Two clicks arriving together settle one duel.
  const answers = await Promise.all([w.click(B, "duel_accept", duel), w.click(B, "duel_accept", duel)])
  expect(answers.filter((answer) => answer.replace_original)).toHaveLength(1)
  expect([w.balance(A), w.balance(B)].sort()).toEqual([120, 80])

  w.deck(10, 5, 10, 7, 2)
  const first = button(await w.say(A, "blackjack 10"))
  expect((await w.click(B, "bj_hit", first)).text).toContain("isn't your hand")
  expect(await w.click(A, "bj_hit", first)).toMatchObject({ response_type: "in_channel", replace_original: true })
  expect((await w.click(A, "bj_stand", first)).replace_original).toBe(true)
  const settled = w.balance(A)
  expect((await w.click(A, "bj_stand", first)).text).toContain("that hand is over")
  // A button from an old hand can't play a new one.
  clock.now += 1_000
  await w.say(A, "blackjack 10")
  expect((await w.click(A, "bj_stand", first)).text).toContain("that hand is over")
  expect(w.balance(A)).toBe(settled - 10)
  expect(w.total()).toBe(700)
})
