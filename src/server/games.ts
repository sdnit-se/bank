// The games themselves: odds, payouts and what Bank says about the result. Nothing here touches the ledger, so the
// maths can be tested on its own. Every game takes its randomness as an argument for the same reason.

/** A uniform whole number from 0 up to, but not including, `n`. */
export type Rand = (n: number) => number

export function secureRand(n: number) {
  // Throw away the top sliver of the range that would make low numbers slightly likelier.
  const limit = Math.floor(0x1_0000_0000 / n) * n
  const buffer = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buffer)
    if (buffer[0]! < limit) return buffer[0]! % n
  }
}

function pick<T>(rand: Rand, items: readonly T[]) {
  return items[rand(items.length)]!
}

// ---------- coin flip

export type Side = "heads" | "tails"

/** A win returns the stake twice over. */
export const FLIP_PAYS = 2

/** Out of 100 flips: 49 land your way, 49 don't, and 2 land on the edge, which the house keeps. */
export function flip(rand: Rand, call: Side): { landed: Side | "edge"; won: boolean } {
  const roll = rand(100)
  if (roll < 2) return { landed: "edge", won: false }
  const won = roll < 51
  return { landed: won ? call : call === "heads" ? "tails" : "heads", won }
}

// ---------- slots

/** Chances are out of 10,000 spins and `pays` is how many times the stake comes back. Returns 95% over time. */
export const SLOT_TIERS = [
  { name: "jackpot", chances: 75, pays: 20 },
  { name: "triple", chances: 300, pays: 8 },
  { name: "pair", chances: 2800, pays: 2 },
  { name: "nothing", chances: 6825, pays: 0 },
] as const

export const SLOT_TOP = 20

export type SlotTier = (typeof SLOT_TIERS)[number]["name"]

const FRUIT = ["cherries", "lemon", "grapes", "bell", "four_leaf_clover"] as const
const GEM = "gem"

export function spin(rand: Rand): { reels: [string, string, string]; tier: SlotTier; pays: number } {
  let roll = rand(10_000)
  const tier = SLOT_TIERS.find((tier) => (roll -= tier.chances) < 0)!
  if (tier.name === "jackpot") return { reels: [GEM, GEM, GEM], tier: tier.name, pays: tier.pays }
  const first = pick(rand, FRUIT)
  if (tier.name === "triple") return { reels: [first, first, first], tier: tier.name, pays: tier.pays }
  const others = FRUIT.filter((fruit) => fruit !== first)
  const second = pick(rand, others)
  if (tier.name === "pair") {
    const reels: [string, string, string] = [first, first, first]
    reels[rand(3)] = second
    return { reels, tier: tier.name, pays: tier.pays }
  }
  const third = pick(
    rand,
    others.filter((fruit) => fruit !== second),
  )
  return { reels: [first, second, third], tier: tier.name, pays: tier.pays }
}

// ---------- lottery

/** One coin is one ticket, and every ticket is as likely as the next. */
export function draw(rand: Rand, tickets: { user: string; count: number }[]) {
  const total = tickets.reduce((sum, ticket) => sum + ticket.count, 0)
  if (total <= 0) return null
  let roll = rand(total)
  return tickets.find((ticket) => (roll -= ticket.count) < 0)!.user
}

/** Draws are daily at 14:00 UTC, mid-afternoon in Stockholm. */
export function nextDraw(now: number) {
  const date = new Date(now)
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 14)
  return today > now ? today : today + 24 * 60 * 60 * 1000
}

// ---------- what Bank says

type Line = (words: Record<string, string>) => string

function say(rand: Rand, lines: readonly Line[], words: Record<string, string>) {
  return pick(rand, lines)(words)
}

const FLIP_WON: Line[] = [
  (w) => `${w.user} called ${w.call} and it landed ${w.call}. *+${w.amount}*. even a broken clock.`,
  (w) => `${w.call}. ${w.user} takes *${w.amount}* off the house. enjoy it, statistics is coming for you.`,
  (w) => `${w.user} won *${w.amount}* on a coin flip. please don't put this in your retirement plan.`,
  (w) => `${w.user} is up *${w.amount}*. this is the exact moment a smarter person would stop.`,
]

const FLIP_LOST: Line[] = [
  (w) => `${w.user} called ${w.call}. it was ${w.landed}. *${w.amount}* gone. the coin has two sides and you found the wrong one.`,
  (w) => `${w.landed}. ${w.user} just donated *${w.amount}* to the house. generous. stupid, but generous.`,
  (w) => `${w.user} lost *${w.amount}* on a coin flip, a game with no skill involved, and was still bad at it.`,
  (w) => `${w.user} is down *${w.amount}*. the house thanks you for your continued lack of judgement.`,
]

const FLIP_EDGE: Line[] = [
  (w) => `the coin landed on its edge. the house keeps ${w.user}'s *${w.amount}*. no, there is no appeals process.`,
  (w) => `edge. it actually landed on the edge. ${w.user} loses *${w.amount}* to physics.`,
]

export function flipLine(rand: Rand, result: { landed: string; won: boolean }, words: Record<string, string>) {
  const lines = result.won ? FLIP_WON : result.landed === "edge" ? FLIP_EDGE : FLIP_LOST
  return `:coin: ${say(rand, lines, { ...words, landed: result.landed })}`
}

const SLOT_LINES: Record<SlotTier, Line[]> = {
  nothing: [
    (w) => `${w.user} fed *${w.amount}* to the machine. the machine says thanks.`,
    (w) => `nothing. ${w.user} is down *${w.amount}* and up one bad decision.`,
    (w) => `${w.user} lost *${w.amount}*. the lights and noises were free, though.`,
    (w) => `${w.user} pays *${w.amount}* for three fruits that don't match. a salad would have been cheaper.`,
  ],
  pair: [
    (w) => `a pair. ${w.user} gets *${w.win}* back, along with the dangerous idea that this works.`,
    (w) => `${w.user} doubles up to *${w.win}*. the house calls this customer retention.`,
  ],
  triple: [
    (w) => `three of a kind. ${w.user} takes *${w.win}*. somebody check that machine.`,
    (w) => `${w.user} wins *${w.win}*. it will all be gone by friday.`,
  ],
  jackpot: [
    (w) => `JACKPOT. ${w.user} takes *${w.win}* and will be insufferable for at least a week.`,
    (w) => `${w.user} hit the jackpot for *${w.win}*. the house would like to file a complaint.`,
  ],
}

export function slotLine(rand: Rand, result: { reels: string[]; tier: SlotTier }, words: Record<string, string>) {
  return `${result.reels.map((reel) => `:${reel}:`).join(" ")}  ·  ${say(rand, SLOT_LINES[result.tier], words)}`
}

const DUEL_OPEN: Line[] = [
  (w) => `${w.from} challenges ${w.to} to a duel for *${w.amount}*. ${w.to}: \`/bank accept\`, or \`/bank decline\` like a coward. you have ten minutes.`,
  (w) => `${w.from} wants ${w.to}'s *${w.amount}* and is willing to flip a coin for it. \`/bank accept\` or \`/bank decline\`. ten minutes, everyone's watching.`,
]

const DUEL_DONE: Line[] = [
  (w) => `${w.winner} beat ${w.loser} in a duel and took *${w.amount}*. ${w.loser}, it was a coin flip and you still lost to them.`,
  (w) => `${w.loser} just paid ${w.winner} *${w.amount}* to be humiliated in public. money well spent.`,
  (w) => `${w.winner} takes *${w.amount}* from ${w.loser}. one of you has to explain this at home.`,
]

const DUEL_DECLINED: Line[] = [
  (w) => `${w.to} declined ${w.from}'s duel. the coins are safe. the reputation is not.`,
  (w) => `${w.to} ran away from ${w.from}. noted, and written down forever.`,
]

export const duelOpenLine = (rand: Rand, words: Record<string, string>) => `:crossed_swords: ${say(rand, DUEL_OPEN, words)}`
export const duelDoneLine = (rand: Rand, words: Record<string, string>) => `:crossed_swords: ${say(rand, DUEL_DONE, words)}`
export const duelDeclinedLine = (rand: Rand, words: Record<string, string>) => `:chicken: ${say(rand, DUEL_DECLINED, words)}`

const TICKETS: Line[] = [
  (w) => `${w.user} bought ${w.tickets}. the pot is *${w.pot}* and their chance of winning it is ${w.chance}. their chance of regret is higher.`,
  (w) => `${w.user} is in the lottery with ${w.tickets}. pot: *${w.pot}*. odds: ${w.chance}. hope: misplaced.`,
]

const DRAWN: Line[] = [
  (w) => `lottery draw: ${w.winner} wins *${w.pot}* holding ${w.share} of the tickets. everyone else, thank you for your donation.`,
  (w) => `the lottery pot of *${w.pot}* goes to ${w.winner}. the rest of you paid for that. see you tomorrow.`,
]

export const ticketLine = (rand: Rand, words: Record<string, string>) => `:tickets: ${say(rand, TICKETS, words)}`
export const drawLine = (rand: Rand, words: Record<string, string>) => `:tada: ${say(rand, DRAWN, words)}`

const BROKE: Line[] = [
  (w) => `you have ${w.balance}. this is a casino, not a charity. go beg.`,
  (w) => `bet declined: you only have ${w.balance}. the leaderboard has a bottom and you're standing on it.`,
  (w) => `you can't afford that with ${w.balance}. try asking a colleague nicely. grovelling works too.`,
]

export const brokeLine = (rand: Rand, words: Record<string, string>) => say(rand, BROKE, words)
