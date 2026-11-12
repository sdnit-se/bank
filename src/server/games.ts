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

// ---------- roulette

/** A European wheel: 0 to 36, one green pocket. Red, black, odd and even pay double; a single number pays 36 times. */
export type Pocket = "red" | "black" | "odd" | "even" | number

const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36])

export function parsePocket(word: string | undefined): Pocket | null {
  const text = (word ?? "").toLowerCase()
  if (text === "red" || text === "black" || text === "odd" || text === "even") return text
  return /^\d{1,2}$/.test(text) && Number(text) <= 36 ? Number(text) : null
}

export const roulettePays = (pocket: Pocket) => (typeof pocket === "number" ? 36 : 2)

export function roulette(rand: Rand, pocket: Pocket) {
  const landed = rand(37)
  const colour = landed === 0 ? ("green" as const) : REDS.has(landed) ? ("red" as const) : ("black" as const)
  const won =
    typeof pocket === "number" ? landed === pocket : landed !== 0 && (pocket === "red" || pocket === "black" ? colour === pocket : (landed % 2 === 1) === (pocket === "odd"))
  return { landed, colour, won, pays: won ? roulettePays(pocket) : 0 }
}

// ---------- blackjack

/** Rank 1 is an ace and 11 to 13 are the jack, queen and king. Cards come from an endless shoe, so nothing is counted. */
export type Card = { rank: number; suit: number }

export const dealCard = (rand: Rand): Card => ({ rank: rand(13) + 1, suit: rand(4) })

/** The best total that doesn't bust, counting aces as 11 while that fits. */
export function handTotal(cards: Card[]) {
  let total = cards.reduce((sum, card) => sum + Math.min(card.rank, 10), 0)
  let aces = cards.filter((card) => card.rank === 1).length
  while (aces-- > 0 && total + 10 <= 21) total += 10
  return total
}

export const isBlackjack = (cards: Card[]) => cards.length === 2 && handTotal(cards) === 21

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
const SUITS = ["♠", "♥", "♦", "♣"]
export const showCards = (cards: Card[]) => cards.map((card) => `${RANKS[card.rank - 1]}${SUITS[card.suit]}`).join(" ")

/** The dealer draws until 17 or more. */
export function dealerPlays(rand: Rand, dealer: Card[]) {
  const cards = [...dealer]
  while (handTotal(cards) < 17) cards.push(dealCard(rand))
  return cards
}

export type Outcome = "blackjack" | "win" | "push" | "lose" | "bust"

/** How many times the stake comes back. A natural pays three to two. */
export const BLACKJACK_PAYS: Record<Outcome, number> = { blackjack: 2.5, win: 2, push: 1, lose: 0, bust: 0 }
export const BLACKJACK_TOP = 2.5

export function settleHand(player: Card[], dealer: Card[]): Outcome {
  const [mine, theirs] = [handTotal(player), handTotal(dealer)]
  if (mine > 21) return "bust"
  if (isBlackjack(player)) return isBlackjack(dealer) ? "push" : "blackjack"
  if (isBlackjack(dealer)) return "lose"
  if (theirs > 21 || mine > theirs) return "win"
  return mine === theirs ? "push" : "lose"
}

// ---------- heists

/** A crew that gets away is paid this many times what each of them put in. */
export const HEIST_PAYS = 3
export const HEIST_CREW = 8

/** The chance of getting away, out of 100. Every pair of hands up to five helps, and even five lose a little on average. */
export const heistChance = (crew: number) => 22 + 2 * Math.min(crew, 5)

// ---------- lottery

/** One coin is one ticket, and every ticket is as likely as the next. */
export function draw(rand: Rand, tickets: { user: string; count: number }[]) {
  const total = tickets.reduce((sum, ticket) => sum + ticket.count, 0)
  if (total <= 0) return null
  let roll = rand(total)
  return tickets.find((ticket) => (roll -= ticket.count) < 0)!.user
}

// ---------- what Bank says

export type Line = (words: Record<string, string>) => string

export function say(rand: Rand, lines: readonly Line[], words: Record<string, string>) {
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
    (w) => `a pair. ${w.user} is *${w.up}* up, along with the dangerous idea that this works.`,
    (w) => `${w.user} doubles their *${w.amount}*. the house calls this customer retention.`,
  ],
  triple: [
    (w) => `three of a kind. ${w.user} is *${w.up}* up. somebody check that machine.`,
    (w) => `${w.user} wins *${w.up}* (${w.win} back). it will all be gone by friday.`,
  ],
  jackpot: [
    (w) => `JACKPOT. ${w.user} is *${w.up}* up and will be insufferable for at least a week.`,
    (w) => `${w.user} hit the jackpot and is *${w.up}* up. the house would like to file a complaint.`,
  ],
}

export function slotLine(rand: Rand, result: { reels: string[]; tier: SlotTier }, words: Record<string, string>) {
  return `${result.reels.map((reel) => `:${reel}:`).join(" ")}  ·  ${say(rand, SLOT_LINES[result.tier], words)}`
}

const DUEL_OPEN: Line[] = [
  (w) => `${w.from} challenges ${w.to} to a duel for *${w.amount}*. ${w.to}: \`/bank accept\`, or \`/bank decline\` like a coward. you have ten minutes.`,
  (w) => `${w.from} wants ${w.to}'s *${w.amount}* and is willing to flip a coin for it. \`/bank accept\` or \`/bank decline\`. ten minutes, everyone's watching.`,
]

const DUEL_ANYONE: Line[] = [
  (w) => `${w.from} will flip a coin against anyone for *${w.amount}*. first to accept gets it. ten minutes.`,
  (w) => `${w.from} has *${w.amount}* and a point to prove. anyone can take the other side of the coin. ten minutes.`,
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

export const duelOpenLine = (rand: Rand, words: Record<string, string>) => `:crossed_swords: ${say(rand, words.to ? DUEL_OPEN : DUEL_ANYONE, words)}`
export const duelDoneLine = (rand: Rand, words: Record<string, string>) => `:crossed_swords: ${say(rand, DUEL_DONE, words)}`
export const duelDeclinedLine = (rand: Rand, words: Record<string, string>) => `:chicken: ${say(rand, DUEL_DECLINED, words)}`

const TICKETS: Line[] = [
  (w) => `${w.user} bought ${w.tickets}. the pot is *${w.pot}* and their chance of winning it is ${w.chance}. their chance of regret is higher.`,
  (w) => `${w.user} is in the lottery with ${w.tickets}. pot: *${w.pot}*. odds: ${w.chance}. hope: misplaced.`,
]

const DRAWN: Line[] = [
  (w) => `lottery draw: ${w.winner} wins the *${w.pot}* pot, ${w.own} of it their own tickets. everyone else, thank you for your donation.`,
  (w) => `the lottery pot of *${w.pot}* goes to ${w.winner}, who put ${w.own} of it in. the rest of you paid for that. see you tomorrow.`,
]

export const ticketLine = (rand: Rand, words: Record<string, string>) => `:tickets: ${say(rand, TICKETS, words)}`
export const drawLine = (rand: Rand, words: Record<string, string>) => `:tada: ${say(rand, DRAWN, words)}`

const ROULETTE_WON: Line[] = [
  (w) => `${w.user} had *${w.amount}* on ${w.pocket} and it came in: *${w.up}* up. the wheel has made a mistake.`,
  (w) => `${w.pocket} it is. ${w.user} takes *${w.up}* off the house and will now believe they have a system.`,
]

const ROULETTE_LOST: Line[] = [
  (w) => `${w.user} had *${w.amount}* on ${w.pocket}. the wheel disagreed.`,
  (w) => `${w.user} loses *${w.amount}*. ${w.pocket} was a feeling, not a strategy.`,
  (w) => `not ${w.pocket}. ${w.user}'s *${w.amount}* now belongs to someone with better furniture.`,
]

export function rouletteLine(rand: Rand, result: { landed: number; colour: string; won: boolean }, words: Record<string, string>) {
  return `:${result.colour === "black" ? "black" : result.colour === "red" ? "red" : "large_green"}_circle: *${result.landed}* · ${say(rand, result.won ? ROULETTE_WON : ROULETTE_LOST, words)}`
}

const HAND_OVER: Record<Outcome, Line[]> = {
  blackjack: [
    (w) => `blackjack. ${w.user} takes *${w.up}* off the house without having to make a single decision, which is when they do best.`,
    (w) => `${w.user} was dealt 21 and is *${w.up}* up. skill had nothing to do with it.`,
  ],
  win: [
    (w) => `${w.user} beats the dealer and takes *${w.up}*. the dealer is a random number generator, but well done.`,
    (w) => `${w.user} wins *${w.up}* (${w.win} back). somewhere a casino executive shrugs.`,
  ],
  push: [(w) => `a push. ${w.user} gets their *${w.amount}* back and has wasted everyone's time.`],
  lose: [
    (w) => `the dealer wins. ${w.user} loses *${w.amount}* to a deck of cards that doesn't exist.`,
    (w) => `${w.user} stood, hopefully, and lost *${w.amount}*. hope is not a card.`,
  ],
  bust: [
    (w) => `bust. ${w.user} asked for one more card, as they always do, and loses *${w.amount}*.`,
    (w) => `${w.user} goes over 21 and loses *${w.amount}*. counting to 21 is the whole game.`,
  ],
}

export const handLine = (rand: Rand, outcome: Outcome, words: Record<string, string>) => say(rand, HAND_OVER[outcome], words)

const HEIST: Record<"won" | "lost", Line[]> = {
  won: [
    (w) => `:moneybag: the crew got away with it. ${w.crew} ${w.walk} out *${w.up}* up each. the house is reviewing its security, and its life choices.`,
    (w) => `:moneybag: ${w.crew} robbed the house and took *${w.up}* each. nobody saw anything. everybody saw everything.`,
  ],
  lost: [
    (w) => `:rotating_light: the heist failed. ${w.crew} lost *${w.amount}* each and ${w.was} last seen waving at the security camera.`,
    (w) => `:rotating_light: ${w.crew} tripped the alarm on the way in. the house keeps *${w.amount}* a head and sends its regards.`,
  ],
}

export const heistLine = (rand: Rand, won: boolean, words: Record<string, string>) => say(rand, HEIST[won ? "won" : "lost"], words)

const BROKE: Line[] = [
  (w) => `you have ${w.balance}. this is a casino, not a charity. go beg.`,
  (w) => `bet declined: you only have ${w.balance}. the leaderboard has a bottom and you're standing on it.`,
  (w) => `you can't afford that with ${w.balance}. try asking a colleague nicely. grovelling works too.`,
]

export const brokeLine = (rand: Rand, words: Record<string, string>) => say(rand, BROKE, words)
