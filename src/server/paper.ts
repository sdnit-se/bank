// The morning paper: one post after the daily round instead of an announcement for every little thing. It reads the
// last day off the ledger and says what happened and why, the way someone who knows how the bank works would tell a
// colleague: the real odds, where the coins went, and the occasional aside. The jokes are meant to be true.
// Wording only: no coins move here. A day with nothing to report gets no paper.

import { BONDS, CENTRAL, CENTS, HOUSE, POOLS, POT } from "../shared/types"
import type { matureBonds } from "./bonds"
import { say, secureRand, type Line } from "./games"
import { held, section, type Block, type Ledger } from "./ledger"
import { money } from "./money"

const NAME = "THE SHEBANG TIMES"
const DAY = 24 * 60 * 60 * 1000
const today = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Stockholm", weekday: "long", day: "numeric", month: "long", year: "numeric" })

/** What the daily round did, which the ledger alone doesn't spell out. */
export type Round = {
  lottery: { winner: string; pot: number; mine: number; sold: number; tax: number } | null
  wealth: { collected: number; payers: number } | null
  matured: ReturnType<typeof matureBonds>
  /** Office bets called off for being open too long. */
  expired: string[]
  honours: { user_id: string; title: string }[]
}

/** Sentences that run most days have more than one way of being said. */
const COPY = {
  ahead: [
    (w) => `${w.who} is up ${w.amount}. The textbook move is to stop now.`,
    (w) => `${w.who} won the most, ${w.amount}. At this sample size every strategy looks like skill.`,
  ],
  houseUp: [
    (w) => `The house kept ${w.hold} of it against an edge of 2% to 5%, so most of today was variance, the house's kind.`,
    (w) => `The house kept ${w.hold} of it. The odds are built for 2% to 5%; the rest is luck, the one thing it doesn't need.`,
  ],
  houseDown: [
    (w) => `The house paid out more than it took in. ${w.bets} is not a sample; a few hundred will be.`,
    (w) => `The house paid out more than it took in, which the law of large numbers permits in the short run. ${w.bets} is the short run.`,
  ],
  thanks: [() => `Still the only coins here that anyone earned.`, () => `The part of the economy the rest is a distraction from.`],
  // Each of these is how the bank actually works.
  footnote: [
    () => `A coin flip lands your way 49% of the time, the other way 49%, and on its edge 2%, which the house keeps. It is the fairest game here and still not fair.`,
    () => `The randomness is the platform's cryptographic generator, with the top sliver of the range thrown away so low numbers aren't slightly likelier. So no, it isn't rigged.`,
    () => `Balances are whole numbers of cents, because money and floating point should never be left alone together.`,
    () => `The house only takes a bet it could pay in full if you won. Several real banks have been run on looser terms.`,
    () => `Slots return 95% over time. "Over time" is carrying most of that sentence.`,
    () => `Nothing in the casino creates or destroys coins. You are all gambling with each other's money, slowly.`,
    () => `The draw is at 09:00 in Stockholm all year. The code finds it by stepping forward an hour at a time until the clock says nine, which is one way to handle daylight saving.`,
    () => `A roulette number pays 36 times on a wheel with 37 pockets. The missing pocket is the entire business.`,
    () => `Coins in a bond can't be bet, given away or taxed as wealth. Finance calls this a lock-up. Here it is the only known cure for blackjack.`,
    () => `Every balance can be rebuilt from the list of transactions, which is the real record. The balances are a cache, with everything that implies.`,
  ],
} satisfies Record<string, Line[]>

export async function publish(ledger: Ledger, round: Round, now = Date.now()) {
  const channel = ledger.meta<string>("lottery_channel")
  if (!channel) return false
  // Everything since the last round, so nothing is reported twice, and never more than two days of it.
  const since = Math.max(ledger.meta<number>("paper_at") ?? now - DAY, now - 2 * DAY)
  ledger.setMeta("paper_at", now)
  const config = ledger.config()
  const coins = (cents: number) => money(config, cents)
  const at = (id: string) => `<@${id}>`
  const names = (ids: string[]) => ids.slice(0, 8).map(at).join(", ")
  const count = (n: number, one: string, many: string) => (n === 1 ? `One ${one}` : `${n} ${many}`)
  const percent = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`

  // One pass over the day: who is up and down against the house, who thanked whom, and what else changed hands.
  const net = new Map<string, number>()
  const thanked = new Map<string, number>()
  const gave = new Set<string>()
  const add = (map: Map<string, number>, id: string, amount: number) => map.set(id, (map.get(id) ?? 0) + amount)
  const day = { bets: 0, staked: 0, thanks: 0, duels: 0, trades: 0, traded: 0, lent: 0, robbed: 0, crew: 0, pooled: 0 }
  const bought: string[] = []
  const callers = new Set<string>()
  const rows = ledger.sql
    .exec<{ kind: string; from_id: string | null; to_id: string | null; amount: number; note: string | null }>("select kind, from_id, to_id, amount, note from entries where at > ? order by id", since)
    .toArray()
  for (const row of rows) {
    const heist = row.note === "heist"
    if (row.kind === "bet" && row.to_id === HOUSE) {
      day.bets++
      day.staked += row.amount
      add(net, row.from_id!, -row.amount)
      if (heist) day.crew += row.amount
    } else if (row.kind === "payout" && row.from_id === HOUSE) {
      add(net, row.to_id!, row.amount)
      if (heist) day.robbed += row.amount
    } else if (row.kind === "payout" && row.from_id === POOLS && row.note === "the office pool") {
      callers.add(row.to_id!)
      day.pooled += row.amount
    } else if (row.kind === "give" || row.kind === "reaction") {
      day.thanks++
      add(thanked, row.to_id!, row.amount)
      gave.add(`${row.from_id} ${row.to_id}`)
    } else if (row.kind === "buy" || row.kind === "sell") {
      day.trades++
      day.traded += row.amount
    } else if (row.kind === "duel") day.duels++
    else if (row.kind === "bond" && row.to_id === BONDS) day.lent += row.amount
    else if (row.kind === "shop") bought.push(`${at(row.from_id!)} bought "${row.note}" for ${coins(row.amount)}`)
  }
  const ranked = [...net].sort((a, b) => b[1] - a[1])
  const [best, worst] = [ranked[0], ranked.at(-1)]
  const house = -ranked.reduce((sum, [, amount]) => sum + amount, 0)
  const top = [...thanked].sort((a, b) => b[1] - a[1])[0]
  // Two people who gave each other coins the same day, each pair once.
  const mutual = [...gave].map((pair) => pair.split(" ")).filter(([from, to]) => from! < to! && gave.has(`${to} ${from}`))
  const asked = ledger.sql.exec<{ id: number; question: string }>("select id, question from pools where at > ? order by id", since).toArray()

  const stories: { head: string; body: string }[] = []
  const story = (head: string, ...body: (string | false | undefined)[]) => stories.push({ head, body: body.filter(Boolean).join(" ") })

  if (round.lottery) {
    const { winner, pot, mine, sold, tax } = round.lottery
    const each = Math.round(pot / sold)
    story(
      `${at(winner)} wins the lottery: ${coins(pot)}`,
      mine === sold ? `${at(winner)} held every ticket, so the odds were excellent.` : `${at(winner)} held ${mine} of the ${sold} tickets, a ${percent(mine, sold)} chance.`,
      each > CENTS && `The pot came to ${coins(each)} a ticket against a price of ${coins(CENTS)}, since the central bank tops up every draw: the one game here with a positive expected return.`,
      tax > 0 && `(${coins(tax)} went back as winnings tax.)`,
    )
  }
  if (day.crew) {
    const odds = "It pays three times the stake and works 24% to 32% of the time, depending on the crew."
    if (day.robbed) story(`A heist came off: ${coins(day.robbed - day.crew)} out of the house`, odds, "Bad risk management with good results, which is how most reputations are made.")
    else story(`A heist failed and cost its crew ${coins(day.crew)}`, odds, "This was one of the other times.")
  }
  if (day.bets && best && worst) {
    const words = { hold: percent(house, day.staked), bets: count(day.bets, "bet", "bets") }
    story(
      house > 0 ? `The house made ${coins(house)}` : house < 0 ? `The house lost ${coins(-house)}` : "The house broke even",
      `${words.bets}, ${coins(day.staked)} staked.`,
      house * 20 > day.staked
        ? say(secureRand, COPY.houseUp, words)
        : house > 0
          ? `The house kept ${words.hold} of it, which is the odds doing roughly what they say.`
          : house < 0 && say(secureRand, COPY.houseDown, words),
      house > 0 && worst[1] < 0 && `${at(worst[0])} lost the most, ${coins(-worst[1])}.`,
      house <= 0 && best[1] > 0 && say(secureRand, COPY.ahead, { who: at(best[0]), amount: coins(best[1]) }),
      day.duels > 0 && `${count(day.duels, "duel", "duels")}, too: a fair coin and no edge.`,
    )
  }
  if (top) {
    const total = [...thanked.values()].reduce((sum, amount) => sum + amount, 0)
    const [a, b] = mutual[0] ?? []
    story(
      `${coins(total)} given as thanks`,
      `${count(day.thanks, "thank-you", "thank-yous")}, and ${at(top[0])} got the most (${coins(top[1])}).`,
      a && b
        ? `${at(a)} and ${at(b)} gave each other coins in both directions, which nets to nothing and counts twice toward GDP. Energy traders called this round-tripping. Here it is being nice, so we allow it.`
        : say(secureRand, COPY.thanks, {}),
    )
  }
  const rate = config.taxes.interest
  if (round.matured) {
    const { owners, lent, paid, short } = round.matured
    if (short) story("The central bank came up short on bond interest", `${names(owners)} got ${coins(lent)} back with ${coins(paid)} in interest, less than promised. What was lent was never at risk; the interest depended on reserves the bank didn't have. Strictly, a default.`)
    else story(`Bonds paid out: ${coins(lent)} back, ${coins(paid)} in interest`, `${names(owners)} lent the central bank coins for a week and got them back with interest. That is the whole idea, and it still feels suspicious in this building.`)
  } else if (day.lent) {
    const yearly = Math.round(((1 + rate / 100) ** 52 - 1) * 100).toLocaleString("en-GB")
    story(`${coins(day.lent)} went into bonds`, rate > 0 && `Locked for a week at ${rate}%, or ${yearly}% a year compounded, paid from the central bank's reserves if it has them.`, "A bond with credit risk, issued by an institution funded by a casino.")
  }
  if (round.wealth?.collected) {
    story(
      `Wealth tax: ${coins(round.wealth.collected)} from ${count(round.wealth.payers, "person", "people").toLowerCase()}`,
      `${config.taxes.wealth}% of whatever anyone holds above ${coins(config.taxes.wealthAbove)}, once a week. Coins in bonds don't count, which is the policy and not a loophole. (We wrote it.)`,
    )
  }
  if (callers.size) story(`An office bet settled: ${names([...callers])} ${callers.size === 1 ? "collects" : "collect"} ${coins(day.pooled)}`, "No bookmaker's cut: the side that was wrong pays the side that was right.")
  if (asked.length) story(`New office bet: "${asked[0]!.question}"`, asked.map((pool) => `\`/bank pool ${pool.id}\` to take a side on #${pool.id}.`).join(" "), "The payout is set by whoever disagrees with you.")
  if (round.expired.length) story(`"${round.expired[0]}" expired unanswered`, "Thirty days without a ruling, so every stake went back. Some questions are not decidable.")
  if (day.trades) story(`${count(day.trades, "trade", "trades")} on the stock market, ${coins(day.traded)}`, "Real prices, play money. Losses pay other people's gains, and when they don't cover it the market prints the difference.")
  if (bought.length) story(bought[0]!, ...bought.slice(1, 6).map((line) => `${line}.`), "The first transaction here an economist would recognise: money, for a thing.")
  if (round.honours.length) {
    const more = round.honours.length > 8 && `And ${round.honours.length - 8} more, all under \`/bank titles\`.`
    story("New titles", ...round.honours.slice(0, 8).map((honour) => `${at(honour.user_id)} is now *${honour.title}*.`), more)
  }
  if (!stories.length) return false

  const edition = (ledger.meta<number>("paper_no") ?? 0) + 1
  const masthead = `${today.format(now)} · issue #${edition}`
  const supply = ledger.sql.exec<{ n: number }>("select sum(balance) as n from accounts").one().n
  const figure = (id: string) => coins(held(ledger, id)).split(" ")[0]
  const glance = `${coins(supply)} in existence · the house holds ${figure(HOUSE)} · the central bank ${figure(CENTRAL)} · the lottery pot ${figure(POT)} · ${figure(BONDS)} in bonds`
  const footnote = `_Footnote:_ ${say(secureRand, COPY.footnote, {})}`
  const text = [`*${NAME}* · ${masthead}`, ...stories.map((item) => `*${item.head}*\n${item.body}`), footnote].join("\n\n")
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: NAME } },
    { type: "context", elements: [{ type: "mrkdwn", text: masthead }] },
    ...stories.map((item) => section(`*${item.head}*\n${item.body}`)),
    { type: "divider" },
    { type: "context", elements: [{ type: "mrkdwn", text: footnote }, { type: "mrkdwn", text: glance }] },
  ]
  const posted = await ledger.call("chat.postMessage", { channel, text, blocks, unfurl_links: false }).then(
    () => true,
    (error: unknown) => (console.error("the paper didn't go out", error), false),
  )
  if (posted) ledger.setMeta("paper_no", edition)
  return posted
}
