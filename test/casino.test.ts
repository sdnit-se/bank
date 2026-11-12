// Plays the casino against the stand-in ledger in world.ts. What matters most here is that no game creates or
// destroys a coin.
import { expect, test } from "bun:test"
import { play, settle } from "../src/server/casino"
import type { Rand } from "../src/server/games"
import type { Message } from "../src/server/ledger"
import { bounties, bountyClick } from "../src/server/bounties"
import { shop, shopClick, stock, unstock } from "../src/server/shop"
import { sources } from "../src/server/stats"
import { heistsDue, interact } from "../src/server/tables"
import { BOUNTIES, CENTRAL, CENTS, HOUSE, nextDraw, POOLS, POT } from "../src/shared/types"
import { A, B, clock, frozen, world as bare } from "./world"

const C = "UCCC"
const D = "UDDD"

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
  // A duel with nobody named goes to the first taker who isn't the challenger.
  w.join(C)
  const open = button(await w.say(C, "duel 20"))
  expect((await w.click(C, "duel_accept", open)).text).toContain("nobody has challenged you")
  expect((await w.click(A, "duel_accept", open)).replace_original).toBe(true)
  expect((await w.click(B, "duel_accept", open)).text).toContain("already settled")
  expect([80, 120]).toContain(w.balance(C))

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
  expect(w.total()).toBe(800)
})

test("a heist costs nobody anything until the crew goes in, and then pays all of them or none", async () => {
  const w = world()
  w.print(HOUSE, 500)
  const plan = button(await w.say(A, "heist 10"))
  expect((await w.click(B, "heist_go", plan)).text).toContain("only <@UAAA> gives the word")
  await w.click(B, "heist_join", plan)
  expect((await w.click(B, "heist_join", plan)).text).toContain("already in the van")
  expect([w.balance(A), w.balance(B)]).toEqual([100, 100])
  w.ledger.rand = () => 0
  await w.click(A, "heist_go", plan)
  expect([w.balance(A), w.balance(B), w.balance(HOUSE)]).toEqual([120, 120, 460])
  expect((await w.click(A, "heist_go", plan)).response_type).toBe("ephemeral")

  w.ledger.rand = () => 99
  await w.say(A, "heist 10")
  await w.say(B, "heist join")
  await w.say(A, "heist go")
  expect([w.balance(A), w.balance(B), w.balance(HOUSE)]).toEqual([110, 110, 480])
  expect(w.total()).toBe(700)

  // The house has to be able to pay the whole crew.
  const poor = world()
  poor.print(HOUSE, 30)
  const small = button(await poor.say(A, "heist 10"))
  expect((await poor.click(B, "heist_join", small)).text).toContain("doesn't hold enough")
})

test("doubling down takes the stake again, deals one card, and pays on both stakes", async () => {
  const w = world()
  w.print(HOUSE, 500)
  // 5 and 6 against the dealer's 10 and 7, then a 10: twenty-one on a doubled stake of 20.
  w.deck(5, 6, 10, 7, 10)
  const hand = await w.say(A, "blackjack 10")
  const actions = hand!.blocks![1]!
  expect(actions.type === "actions" && actions.elements.map((element) => element.action_id)).toEqual(["bj_hit", "bj_stand", "bj_double"])
  const done = await w.click(A, "bj_double", button(hand))
  expect(done.text).toContain("doubled")
  expect([w.balance(A), w.balance(HOUSE)]).toEqual([120, 480])
  // After a hit there is no doubling.
  w.deck(2, 3, 10, 7, 2)
  await w.say(A, "blackjack 10")
  await w.say(A, "hit")
  expect((await w.say(A, "double"))!.text).toContain("first two cards")
  expect(w.total()).toBe(700)
})

test("either side of a duel can go again, for the same stake or double, and nobody else can", async () => {
  const w = world()
  w.join(C)
  await w.say(A, "duel <@UBBB> 10")
  const result = await w.say(B, "accept")
  const pair = button(result)
  expect((await w.click(C, "duel_rematch", pair)).text).toContain("that was their duel")
  const again = await w.click(B, "duel_double", pair)
  expect(again.response_type).toBe("in_channel")
  expect(again.text).toContain("20 coins")
  const before = w.balance(A)
  await w.say(A, "accept")
  expect(Math.abs(w.balance(A) - before)).toBe(20)
  expect(w.balance(A) + w.balance(B)).toBe(200)
})

test("a caught crew sits out heists until it pays bail, and a heist nobody starts goes in by itself", async () => {
  const w = world()
  w.join(C)
  w.print(HOUSE, 500)
  w.ledger.rand = () => 99
  await w.say(A, "heist 10")
  await w.say(B, "heist join")
  await w.say(A, "heist go")
  expect((await w.say(A, "heist 10"))!.text).toContain("you're in jail for another 15 minutes")
  expect((await w.say(C, "bail"))!.text).toContain("aren't in jail")
  // C bails A out: the stake again, to the central bank. B serves the time.
  expect((await w.say(C, "bail <@UAAA>"))!.response_type).toBe("in_channel")
  expect([w.balance(A), w.balance(C), w.balance(CENTRAL)]).toEqual([90, 90, 10])
  expect((await w.say(B, "heist join"))!.text).toContain("jail")
  clock.now += 15 * 60_000

  // Nobody says go: ten minutes later the alarm sends the crew in and says so where it was planned.
  w.ledger.rand = () => 0
  await w.say(A, "heist 10", "C42")
  await w.say(B, "heist join")
  expect(w.alarm()).toBe(clock.now + 10 * 60_000)
  clock.now += 10 * 60_000
  expect(await heistsDue(w.ledger)).toBe(1)
  expect(w.posts.at(-1)).toMatchObject({ channel: "C42" })
  expect([w.balance(A), w.balance(B)]).toEqual([110, 110])
  expect(w.total()).toBe(800)
})

test("an office bet pays the whole pot to the side that was right, and gives stakes back when nobody was", async () => {
  const w = world()
  w.join(C)
  w.join(D)
  const first = button(await w.say(A, "pool 10 will the demo work?"))
  expect((await w.click(A, "pool_yes", first)).text).toContain("don't get to bet on it")
  await w.click(B, "pool_yes", first)
  await w.click(B, "pool_yes", first)
  expect((await w.click(B, "pool_yes", first)).text).toContain("the most anyone can put on one question")
  await w.click(C, "pool_no", first)
  expect((await w.click(C, "pool_yes", first)).text).toContain("no hedging")
  expect(w.balance(POOLS)).toBe(30)
  expect((await w.click(B, "pool_rule", `${first}:yes`)).text).toContain("only <@UAAA> or an admin")
  await w.click(A, "pool_rule", `${first}:yes`)
  expect([w.balance(A), w.balance(B), w.balance(C), w.balance(POOLS)]).toEqual([100, 110, 90, 0])

  // Three stakes of five cents don't split two ways, and still nothing is left with the bookmaker.
  const odd = button(await w.say(A, "pool 0.05 is it friday?"))
  for (const [user, side] of [[B, "pool_yes"], [C, "pool_yes"], [D, "pool_no"]] as const) await w.click(user, side, odd)
  await w.say(A, `pool ${odd} yes won`)
  expect([w.balance(B) + w.balance(C), w.balance(D), w.balance(POOLS)]).toEqual([200.05, 99.95, 0])

  // Nobody on the side that was right, and a question left open for a month: everyone gets their stake back.
  const wrong = button(await w.say(A, "pool 10 will it rain?"))
  await w.click(B, "pool_yes", wrong)
  await w.click(A, "pool_rule", `${wrong}:no`)
  const old = button(await w.say(A, "pool 10 will we ever know?"))
  await w.click(D, "pool_no", old)
  expect(w.balance(POOLS)).toBe(10)
  clock.now += 31 * 24 * 60 * 60_000
  await settle(w.ledger)
  expect([w.balance(B) + w.balance(C), w.balance(D), w.balance(POOLS)]).toEqual([200.05, 99.95, 0])
  expect(w.total()).toBe(400)
})

test("a shop pays whoever runs it, the bank's pays the central bank, and only its owner can change it", async () => {
  const w = world()
  w.join(C)
  w.ledger.admin = (id: string) => id === A
  w.config.taxes.transfer = 10
  const ask = (user: string, ...words: string[]) => shop(w.ledger, { sub: "shop", words, user })
  expect(stock(w.ledger, B, { bank: true, name: "Pick the lunch place", price: 60 })).toBe("that isn't your shop.")
  expect(stock(w.ledger, A, { bank: true, name: "Pick the lunch place", price: 60 })).toBeNull()
  expect(stock(w.ledger, B, { name: "A code review", price: 10, stock: 1 })).toBeNull()
  expect(unstock(w.ledger, A, 2)).toBe("that isn't your shop.")

  // A buys B's review: B is paid, less the transfer tax, and told directly. Then it's sold out.
  expect((await ask(A, "2"))!.response_type).toBe("in_channel")
  expect([w.balance(A), w.balance(B), w.balance(CENTRAL)]).toEqual([90, 109, 1])
  expect(w.posts.at(-1)).toMatchObject({ channel: B })
  expect((await ask(C, "2"))!.text).toContain("sold out")
  expect((await ask(B, "1"))!.response_type).toBe("in_channel")
  expect((await shopClick(w.ledger, { user: C, action: "shop_buy", value: "Pick the lunch place" }))!.response_type).toBe("in_channel")
  expect([w.balance(B), w.balance(C), w.balance(CENTRAL)]).toEqual([49, 40, 121])
  expect(w.total()).toBe(300)
})

test("a bounty holds everyone's coins until the poster pays them, as a thank-you, to someone else", async () => {
  const w = world()
  w.join(C)
  const say = (user: string, text: string) => bounties(w.ledger, { sub: "bounty", words: text.split(" "), user, channel: "C1" })
  const click = (user: string, action: string, value: string) => bountyClick(w.ledger, { user, action, value })
  const id = button(await say(A, "30 fix the flaky test"))
  await click(B, "bounty_chip", id)
  expect([w.balance(A), w.balance(B), w.balance(BOUNTIES)]).toEqual([70, 95, 35])
  expect((await click(A, "bounty_claim", id))!.text).toContain("can't claim your own")
  await click(C, "bounty_claim", id)
  expect((await click(B, "bounty_rule", `${id}:pay:${C}`))!.text).toContain("only <@UAAA> or an admin")
  expect((await say(A, `${id} pay <@UAAA>`))!.text).toContain("can't pay your own bounty")
  await click(A, "bounty_rule", `${id}:pay:${C}`)
  expect([w.balance(C), w.balance(BOUNTIES)]).toEqual([135, 0])
  // It is a gift from the bounty board, so it counts toward what C has been given by people.
  expect(sources(w.ledger, C).colleagues).toBe(35 * CENTS)
  expect((await click(A, "bounty_rule", `${id}:off`))!.text).toContain("closed")

  // Called off, or left for a month, everyone gets back what they put in.
  const off = button(await say(A, "10 water the plants"))
  await click(B, "bounty_chip", off)
  await click(A, "bounty_rule", `${off}:off`)
  await say(B, "20 document the deploy")
  clock.now += 31 * 24 * 60 * 60_000
  await settle(w.ledger)
  expect([w.balance(A), w.balance(B), w.balance(BOUNTIES)]).toEqual([70, 95, 0])
  expect(w.total()).toBe(300)
})
