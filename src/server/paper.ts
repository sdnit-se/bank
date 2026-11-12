// The morning paper: one post after the daily round instead of an announcement for every little thing. It reads the
// last day off the ledger and gives each thing that happened a headline and a line about it. It doesn't explain how
// the bank works; `/bank help` does that. Wording only: no coins move here. A day with nothing to report gets no paper.

import { BONDS, BOUNTIES, CENTRAL, HOUSE, POOLS, POT } from "../shared/types"
import type { matureBonds } from "./bonds"
import { say, secureRand, type Line } from "./games"
import { held, newsroom, section, type Block, type Ledger } from "./ledger"
import { money } from "./money"

const NAME = "THE SHEBANG TIMES"
const DAY = 24 * 60 * 60 * 1000
const today = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Stockholm", weekday: "long", day: "numeric", month: "long", year: "numeric" })
const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Stockholm", weekday: "long" })

/** What the daily round did, which the ledger alone doesn't spell out. */
export type Round = {
  lottery: { winner: string; pot: number; mine: number; sold: number; tax: number } | null
  wealth: { collected: number; payers: number } | null
  matured: ReturnType<typeof matureBonds>
  /** Office bets called off for being open too long. */
  expired: string[]
  /** Bounties called off for the same reason. */
  abandoned: string[]
  honours: { user_id: string; title: string }[]
}

/** What goes under each headline. Anything that happens most days has a few ways of being said. */
const COPY = {
  lottery: [
    (w) => `${w.winner} held ${w.mine} of the ${w.sold} tickets, a ${w.chance} shot, and will now explain to everyone that it was a system.`,
    (w) => `A ${w.chance} chance came in for ${w.winner}. The other ${w.rest} tickets have been thanked for their contribution to ${w.winner}'s net worth.`,
    (w) => `${w.winner} won on ${w.mine} of ${w.sold} tickets. Everyone else is reminded that the lottery is a tax on people who are bad at maths, paid to someone who is also bad at maths.`,
  ],
  lotteryAlone: [(w) => `${w.winner} bought every ticket in the draw and then won it. Flawless risk management (the competition was nobody).`],
  robbed: [
    () => `They robbed a casino they could have just beaten at coin flips, at worse odds, and it worked, so now it's a strategy.`,
    () => `The house has reviewed the footage and concluded that it was, in fact, robbed. Insurers have been notified (there are no insurers).`,
  ],
  foiled: [
    () => `They tried to rob an institution that takes everyone's money legally and with far less effort. Lessons were not learned.`,
    () => `It turns out the house is better at taking money than at having it taken. The crew is said to be regrouping.`,
  ],
  houseUp: [
    (w) => `${w.who} personally financed ${w.amount} of it, and would like it known that the plan was working right up until it wasn't.`,
    (w) => `${w.who} supplied ${w.amount} of it. Some people have a savings account. ${w.who} has the house.`,
    (w) => `It kept ${w.hold} of everything staked (it's meant to keep about 3%), mostly thanks to ${w.who}, who is down ${w.amount} and feels due.`,
  ],
  houseDown: [
    (w) => `${w.who} took ${w.amount} off it and is going to be unbearable about it. The house would like to stress that this is temporary. (It always is.)`,
    (w) => `${w.who} is up ${w.amount}. The smart move is to stop. See you at the roulette table, ${w.who}.`,
    (w) => `The house congratulates ${w.who} on the ${w.amount}, through its teeth, and looks forward to having it back by Friday.`,
  ],
  thanks: [
    (w) => `${w.who} was thanked the most (${w.amount}), presumably for doing actual work. Unusual behaviour for a casino, but we allow it.`,
    (w) => `Most of it went to ${w.who} (${w.amount}). Somebody did their job well enough that a colleague paid for it out of pocket. Unheard of.`,
    (w) => `${w.who} leads with ${w.amount}. This remains, somehow, what the bank is for.`,
  ],
  mutual: [
    (w) => `${w.a} and ${w.b} gave each other coins in both directions, which is either friendship or a very small money-laundering operation. We've chosen not to ask.`,
    (w) => `${w.a} and ${w.b} sent each other coins both ways and ended up exactly where they started. Regulators call that round-tripping. We call it a cry for help.`,
  ],
  lent: [
    (w) => `${w.rate}% a week, so ${w.yearly}% a year, from a central bank funded by a casino. What could go wrong? (Everything, but slowly.)`,
    (w) => `Somebody here chose the safe option. In this building. We're as surprised as you are. (${w.rate}% a week, since you ask.)`,
  ],
  matured: [(w) => `${w.owners} lent money to the central bank and actually got it back. Nobody is more surprised than the central bank.`],
  defaulted: [(w) => `${w.owners} got the ${w.lent} back, with ${w.paid} of the interest they were promised. In the trade this is called a default. Here it's called ${w.day}.`],
  wealth: [
    (w) => `Paid by ${w.payers}, who discovered that the reward for not gambling it all away is a bill.`,
    (w) => `Collected from ${w.payers} who failed to lose it at blackjack in time. Let that be a lesson.`,
  ],
  called: [
    (w) => `${w.who} got paid for being right, a rare and poorly paid skill around here.`,
    (w) => `${w.who} called it. The other side was wrong, in public, with money, which is how every disagreement in this office should be settled.`,
  ],
  asked: [(w) => `Opinions are free. Being wrong costs coins: ${w.how}`],
  expired: [() => `Thirty days and nobody could say how it went, so the stakes went back. As a company we remain undecided on a number of things.`],
  trades: [
    () => `Somewhere a professional fund manager is underperforming an index for a fee. Here we do it for free.`,
    () => `All placed by people who also lose at coin flips. Past performance, etc.`,
    () => `None of this is financial advice, mostly because none of it was advisable.`,
  ],
  collected: [
    () => `Somebody put a price on a problem and somebody else made it go away. Capitalism, briefly working as advertised.`,
    () => `Paid on completion, no invoice, no net-30. Accounts payable could never.`,
    () => `It had been on someone's list for weeks. The list is shorter now, and so is their patience with everyone else's.`,
  ],
  posted: [
    () => `Somebody would rather pay than do it themselves, which is the most senior thing anyone did yesterday.`,
    () => `The task has officially been ignored long enough to get a budget.`,
  ],
  abandoned: [() => `Thirty days, no takers, coins returned. The task remains, as tasks do.`],
  bought: [() => `Finally, a use for the currency that isn't losing it.`, () => `The coins bought an actual thing. Nobody saw that coming, least of all the coins.`],
} satisfies Record<string, Line[]>

export async function publish(ledger: Ledger, round: Round, now = Date.now()) {
  const channel = newsroom(ledger)
  if (!channel) return false
  // Everything since the last round, so nothing is reported twice, and never more than two days of it.
  const since = Math.max(ledger.meta<number>("paper_at") ?? now - DAY, now - 2 * DAY)
  ledger.setMeta("paper_at", now)
  const config = ledger.config()
  const coins = (cents: number) => money(config, cents)
  // People are named, never mentioned: a mention notifies them, and nobody asked to be woken up by the paper.
  const at = (id: string) => ledger.row(id)?.name ?? "someone"
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
  const collected: { to: string; amount: number; task: string }[] = []
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
    } else if (row.kind === "give" && row.from_id === BOUNTIES) {
      collected.push({ to: row.to_id!, amount: row.amount, task: row.note ?? "a bounty" })
    } else if (row.kind === "give" || row.kind === "reaction") {
      day.thanks++
      add(thanked, row.to_id!, row.amount)
      gave.add(`${row.from_id} ${row.to_id}`)
    } else if (row.kind === "buy" || row.kind === "sell") {
      day.trades++
      day.traded += row.amount
    } else if (row.kind === "duel") day.duels++
    else if (row.kind === "bond" && row.to_id === BONDS) day.lent += row.amount
    else if (row.kind === "shop") bought.push(`${at(row.from_id!)} bought "${row.note}" ${row.to_id === CENTRAL ? "" : `from ${at(row.to_id!)} `}for ${coins(row.amount)}`)
  }
  const ranked = [...net].sort((a, b) => b[1] - a[1])
  const [best, worst] = [ranked[0], ranked.at(-1)]
  const house = -ranked.reduce((sum, [, amount]) => sum + amount, 0)
  const top = [...thanked].sort((a, b) => b[1] - a[1])[0]
  // Two people who gave each other coins the same day, each pair once.
  const mutual = [...gave].map((pair) => pair.split(" ")).filter(([from, to]) => from! < to! && gave.has(`${to} ${from}`))
  const asked = ledger.sql.exec<{ id: number; question: string }>("select id, question from pools where at > ? order by id", since).toArray()
  const pinned = ledger.sql
    .exec<{ id: number; task: string; pot: number }>("select id, task, (select sum(amount) from bounty_funds where bounty = bounties.id) as pot from bounties where at > ? order by id", since)
    .toArray()

  const stories: { head: string; body: string }[] = []
  const story = (head: string, ...body: (string | false | undefined)[]) => stories.push({ head, body: body.filter(Boolean).join(" ") })

  const line = (lines: Line[], words: Record<string, string> = {}) => say(secureRand, lines, words)

  if (round.lottery) {
    const { winner, pot, mine, sold, tax } = round.lottery
    const words = { winner: at(winner), mine: String(mine), sold: String(sold), rest: String(sold - mine), chance: percent(mine, sold) }
    story(`${at(winner)} wins the lottery: ${coins(pot)}`, line(mine === sold ? COPY.lotteryAlone : COPY.lottery, words), tax > 0 && `(The taxman took ${coins(tax)}.)`)
  }
  if (day.crew) {
    if (day.robbed) story(`A heist came off: ${coins(day.robbed - day.crew)} out of the house`, line(COPY.robbed))
    else story(`A heist failed and cost its crew ${coins(day.crew)}`, line(COPY.foiled))
  }
  if (day.bets && best && worst) {
    const off = `off ${count(day.bets, "bet", "bets").toLowerCase()}`
    const duels = day.duels > 0 && `Also ${count(day.duels, "duel", "duels").toLowerCase()}, the only game here where you lose to a colleague instead of to arithmetic.`
    if (house > 0) story(`The house made ${coins(house)} ${off}`, worst[1] < 0 && line(COPY.houseUp, { who: at(worst[0]), amount: coins(-worst[1]), hold: percent(house, day.staked) }), duels)
    else if (house < 0) story(`The house lost ${coins(-house)} ${off}`, best[1] > 0 && line(COPY.houseDown, { who: at(best[0]), amount: coins(best[1]) }), duels)
    else story(`The house broke even ${off}`, "Coins went in, the same coins came out, and everyone involved wasted their time very efficiently.", duels)
  }
  if (top) {
    const total = [...thanked.values()].reduce((sum, amount) => sum + amount, 0)
    const [a, b] = mutual[0] ?? []
    story(`${coins(total)} given as thanks`, line(COPY.thanks, { who: at(top[0]), amount: coins(top[1]) }), a && b && line(COPY.mutual, { a: at(a), b: at(b) }))
  }
  for (const bounty of collected.slice(0, 3)) story(`${at(bounty.to)} collected ${coins(bounty.amount)} for "${bounty.task}"`, line(COPY.collected))
  if (pinned.length) {
    const [first] = pinned
    story(`New bounty: ${coins(first!.pot)} for "${first!.task}"`, line(COPY.posted), pinned.map((bounty) => `\`/bank bounty ${bounty.id}\``).join(", ") + " to claim it.")
  }
  if (round.abandoned.length) story(`"${round.abandoned[0]}" went unclaimed`, line(COPY.abandoned))
  const rate = config.taxes.interest
  if (round.matured) {
    const { owners, lent, paid, short } = round.matured
    const words = { owners: names(owners), lent: coins(lent), paid: coins(paid), day: weekday.format(now) }
    if (short) story("The central bank came up short on bond interest", line(COPY.defaulted, words))
    else story(`Bonds paid out: ${coins(lent)} back, ${coins(paid)} in interest`, line(COPY.matured, words))
  } else if (day.lent) {
    const yearly = Math.round(((1 + rate / 100) ** 52 - 1) * 100).toLocaleString("en-GB")
    story(`${coins(day.lent)} went into bonds`, rate > 0 && line(COPY.lent, { rate: String(rate), yearly }))
  }
  if (round.wealth?.collected) story(`Wealth tax: ${coins(round.wealth.collected)}`, line(COPY.wealth, { payers: count(round.wealth.payers, "person", "people").toLowerCase() }))
  if (callers.size) story(`An office bet settled for ${coins(day.pooled)}`, line(COPY.called, { who: names([...callers]) }))
  if (asked.length) story(`New office bet: "${asked[0]!.question}"`, line(COPY.asked, { how: asked.map((pool) => `\`/bank pool ${pool.id}\``).join(", ") }))
  if (round.expired.length) story(`"${round.expired[0]}" expired unanswered`, line(COPY.expired))
  if (day.trades) story(`${count(day.trades, "trade", "trades")} on the stock market, ${coins(day.traded)}`, line(COPY.trades))
  if (bought.length) story(bought[0]!, ...bought.slice(1, 6).map((item) => `${item}.`), line(COPY.bought))
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
  const text = [`*${NAME}* · ${masthead}`, ...stories.map((item) => `*${item.head}*\n${item.body}`)].join("\n\n")
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: NAME } },
    { type: "context", elements: [{ type: "mrkdwn", text: masthead }] },
    ...stories.map((item) => section(`*${item.head}*\n${item.body}`)),
    { type: "divider" },
    { type: "context", elements: [{ type: "mrkdwn", text: glance }] },
  ]
  const posted = await ledger.call("chat.postMessage", { channel, text, blocks, unfurl_links: false }).then(
    () => true,
    (error: unknown) => (console.error("the paper didn't go out", error), false),
  )
  if (posted) ledger.setMeta("paper_no", edition)
  return posted
}
