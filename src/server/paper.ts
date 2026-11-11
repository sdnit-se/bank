// The morning paper: one post after the daily round instead of an announcement for every little thing. It reads the
// last day off the ledger and reports it in the dry voice of a business paper, written by people who spend their
// days in terminals. Wording only: no coins move here. A day with nothing to report gets no paper.

import { BONDS, CENTRAL, HOUSE, POOLS, POT } from "../shared/types"
import type { matureBonds } from "./bonds"
import { say, secureRand, type Line } from "./games"
import { held, section, type Block, type Ledger } from "./ledger"
import { money } from "./money"

const NAME = "THE SHEBANG TIMES"
const DAY = 24 * 60 * 60 * 1000
const today = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Stockholm", weekday: "long", day: "numeric", month: "long", year: "numeric" })

/** What the daily round did, which the ledger alone doesn't spell out. */
export type Round = {
  lottery: { winner: string; pot: number; share: string; tax: number } | null
  wealth: { collected: number; payers: number } | null
  matured: ReturnType<typeof matureBonds>
  /** Office bets called off for being open too long. */
  expired: string[]
  honours: { user_id: string; title: string }[]
}

/** A headline, a line break, and what goes under it. A story that runs most days has more than one way of being told. */
const COPY = {
  lottery: [
    (w) => `${w.winner} wins ${w.pot} in the daily draw\n${w.winner} held ${w.share} tickets. The result could not be reproduced. The draw runs again at 09:00 tomorrow and, like most cron jobs, will disappoint nearly everyone who depends on it.`,
    (w) => `Lottery pays ${w.pot} to ${w.winner}\nOne ticket-holder exited with code 0 this morning. The rest were terminated without output. ${w.winner}, who held ${w.share} tickets, has declined to share the seed.`,
    (w) => `${w.winner} takes the lottery pot of ${w.pot}\nA review of the draw found no bug, to the disappointment of everyone else who bought a ticket. ${w.winner} held ${w.share}.`,
  ],
  robbed: [
    (w) => `Red team takes ${w.amount} from the house; finding rated critical\nThe house has acknowledged the report and says no patch is planned.`,
    (w) => `House breached for ${w.amount}\nThe crew came in through the front door, which was in scope. The house has opened a ticket and assigned it to nobody.`,
  ],
  foiled: [
    (w) => `Heist fails, costing its crew ${w.amount}\nA post-mortem found that the plan had no rollback. The house has closed the incident as resolved.`,
    (w) => `Red team exercise ends early; house keeps ${w.amount}\nThe crew tripped the first alert on the way in. The house thanked them for the load test.`,
  ],
  houseUp: [
    (w) => `House posts ${w.amount} profit; root cause identified as gamblers`,
    (w) => `House up ${w.amount} as users continue to skip the documentation`,
    (w) => `House books ${w.amount}, in line with the maths`,
  ],
  houseDown: [
    (w) => `House down ${w.amount}; incident review scheduled`,
    (w) => `House loses ${w.amount} to what it calls a known issue with probability`,
  ],
  houseFlat: [() => `House breaks even, and is treating it as an outage`],
  loser: [
    (w) => `${w.who} led the losses, down ${w.amount}, and describes the strategy as "eventually consistent".`,
    (w) => `${w.who} gave up ${w.amount}. A fix is said to be in progress.`,
    (w) => `${w.who} lost ${w.amount} and maintains that it works on their machine.`,
  ],
  winner: [
    (w) => `${w.who} finished up ${w.amount}, a gain expected to be rolled back by Friday.`,
    (w) => `${w.who} took ${w.amount} off the table and has been advised not to redeploy it.`,
  ],
  thanks: [
    (w) => `${w.amount} given for actual work\n${w.sent} sent, and ${w.who} was thanked most, with ${w.most}. It remains the only part of this economy that ships anything.`,
    (w) => `Colleagues thank each other with ${w.amount}\n${w.sent} sent. ${w.who} received the most, ${w.most}. Unlike the rest of this page, it was for something that works in production.`,
  ],
  defaulted: [
    (w) => `Central bank misses interest payment, reports "degraded service"\n${w.lent} came back to ${w.owners} with ${w.paid} of the interest promised. The bank says it is investigating and that a status page will follow.`,
  ],
  matured: [
    (w) => `Bonds mature: ${w.lent} returned with ${w.paid} in interest\n${w.owners} were paid for a week of waiting, the longest anything here has run without a restart.`,
  ],
  lent: [
    (w) => `Savers lock ${w.amount} into bonds\nThe coins are read-only for a week, which analysts called the only working safeguard against blackjack.`,
    (w) => `${w.amount} moves into bonds\nHolders have put their coins in cold storage for a week. The central bank confirmed that it has backups and declined to say whether it has tested them.`,
  ],
  wealth: [
    (w) => `Wealth tax collects ${w.amount} from ${w.payers}\nThe levy applies above a fixed threshold, which those affected have called a hard-coded magic number.`,
  ],
  called: [(w) => `Office bet settles; ${w.who} ${w.collect} ${w.amount}\nThe other side has been asked to update its priors.`],
  asked: [(w) => `Now open: "${w.question}"\n${w.open} Betting stays open until someone checks the logs.`],
  expired: [(w) => `"${w.question}" timed out after thirty days\nAll stakes were returned and the question was closed as "won't fix".`],
  trades: [
    (w) => `${w.trades} worth ${w.amount} on the stock market\nNone came with a thesis. One trader described the approach as agile.`,
    (w) => `${w.amount} traded on the stock market\n${w.trades} went through. Positions were sized by feel and justified afterwards, in line with industry practice for estimates.`,
  ],
  bought: [(w) => `${w.first}\n${w.rest}Analysts noted that the currency can apparently be exchanged for goods, which was not in the original spec.`],
  opinion: [
    () => `"Rewrite the casino in Rust", by someone who has not opened the repo`,
    () => `"It works on my machine", by an investor whose portfolio does not`,
    () => `"We don't have a gambling problem, we have an observability problem"`,
    () => `"The lottery is O(1) to enter and O(never) to win"`,
    () => `"My losses are eventually consistent"`,
    () => `"Bonds are just cron jobs for money"`,
    () => `"A blameless post-mortem of last night's blackjack", in which blame is assigned`,
    () => `"There are two hard problems: cache invalidation, naming things and off-by-one bets"`,
    () => `"Have you tried turning your balance off and on again?"`,
    () => `"It's never DNS", by a man about to find out it was DNS`,
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

  // One pass over the day: who is up and down against the house, who was thanked, and what else changed hands.
  const net = new Map<string, number>()
  const thanked = new Map<string, number>()
  const add = (map: Map<string, number>, id: string, amount: number) => map.set(id, (map.get(id) ?? 0) + amount)
  const day = { bets: 0, thanks: 0, duels: 0, trades: 0, traded: 0, lent: 0, robbed: 0, crew: 0, pooled: 0 }
  const bought: string[] = []
  const callers = new Set<string>()
  const rows = ledger.sql
    .exec<{ kind: string; from_id: string | null; to_id: string | null; amount: number; note: string | null }>("select kind, from_id, to_id, amount, note from entries where at > ? order by id", since)
    .toArray()
  for (const row of rows) {
    const heist = row.note === "heist"
    if (row.kind === "bet" && row.to_id === HOUSE) {
      day.bets++
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
    } else if (row.kind === "buy" || row.kind === "sell") {
      day.trades++
      day.traded += row.amount
    } else if (row.kind === "duel") day.duels++
    else if (row.kind === "bond" && row.to_id === BONDS) day.lent += row.amount
    else if (row.kind === "shop") bought.push(`${at(row.from_id!)} buys "${row.note}" for ${coins(row.amount)}`)
  }
  const ranked = [...net].sort((a, b) => b[1] - a[1])
  const [best, worst] = [ranked[0], ranked.at(-1)]
  const house = -ranked.reduce((sum, [, amount]) => sum + amount, 0)
  const top = [...thanked].sort((a, b) => b[1] - a[1])[0]
  const asked = ledger.sql.exec<{ id: number; question: string }>("select id, question from pools where at > ? order by id", since).toArray()

  const stories: { head: string; body: string }[] = []
  const story = (lines: Line[], words: Record<string, string>, more = "") => {
    const [head, ...rest] = say(secureRand, lines, words).split("\n")
    stories.push({ head: head!, body: [...rest, more].filter(Boolean).join(" ") })
  }
  const count = (n: number, one: string, many: string) => (n === 1 ? `One ${one}` : `${n} ${many}`)

  if (round.lottery) story(COPY.lottery, { winner: at(round.lottery.winner), pot: coins(round.lottery.pot), share: round.lottery.share }, round.lottery.tax ? `The taxman took ${coins(round.lottery.tax)}.` : "")
  if (day.crew) story(day.robbed ? COPY.robbed : COPY.foiled, { amount: coins(Math.abs(day.robbed - day.crew)) })
  if (day.bets && best && worst) {
    const parts = [
      `${count(day.bets, "bet was", "bets were")} placed against the house.`,
      worst[1] < 0 ? say(secureRand, COPY.loser, { who: at(worst[0]), amount: coins(-worst[1]) }) : "",
      best[1] > 0 ? say(secureRand, COPY.winner, { who: at(best[0]), amount: coins(best[1]) }) : "Nobody finished ahead, which is the documented behaviour.",
      day.duels ? `${count(day.duels, "duel was", "duels were")} fought, and settled by one random bit${day.duels === 1 ? "" : " apiece"}.` : "",
    ]
    story(house < 0 ? COPY.houseDown : house > 0 ? COPY.houseUp : COPY.houseFlat, { amount: coins(Math.abs(house)) }, parts.filter(Boolean).join(" "))
  }
  if (top) {
    const total = [...thanked.values()].reduce((sum, amount) => sum + amount, 0)
    story(COPY.thanks, { amount: coins(total), sent: count(day.thanks, "thank-you was", "thank-yous were"), who: at(top[0]), most: coins(top[1]) })
  }
  if (round.matured) {
    const { owners, lent, paid, short } = round.matured
    story(short ? COPY.defaulted : COPY.matured, { owners: names(owners), lent: coins(lent), paid: coins(paid) })
  } else if (day.lent) story(COPY.lent, { amount: coins(day.lent) })
  if (round.wealth?.collected) story(COPY.wealth, { amount: coins(round.wealth.collected), payers: count(round.wealth.payers, "person", "people").toLowerCase() })
  if (callers.size) story(COPY.called, { who: names([...callers]), collect: callers.size === 1 ? "collects" : "collect", amount: coins(day.pooled) })
  if (asked.length) story(COPY.asked, { question: asked[0]!.question, open: asked.map((pool) => `Office bet #${pool.id} is open: \`/bank pool ${pool.id}\`.`).join(" ") })
  if (round.expired.length) story(COPY.expired, { question: round.expired[0]! })
  if (day.trades) story(COPY.trades, { trades: count(day.trades, "trade", "trades"), amount: coins(day.traded) })
  if (bought.length) story(COPY.bought, { first: bought[0]!, rest: bought.slice(1, 6).map((line) => `${line}. `).join("") })
  if (round.honours.length) {
    const more = round.honours.length > 8 ? ` And ${round.honours.length - 8} more, all under \`/bank titles\`.` : ""
    stories.push({ head: "The honours list", body: round.honours.slice(0, 8).map((honour) => `${at(honour.user_id)} is now *${honour.title}*.`).join(" ") + more })
  }
  if (!stories.length) return false

  const edition = (ledger.meta<number>("paper_no") ?? 0) + 1
  const masthead = `${today.format(now)} · issue #${edition} · all the news that fits in stdout`
  const supply = ledger.sql.exec<{ n: number }>("select sum(balance) as n from accounts").one().n
  const figure = (id: string) => coins(held(ledger, id)).split(" ")[0]
  const glance = `${coins(supply)} in existence · the house holds ${figure(HOUSE)} · the central bank ${figure(CENTRAL)} · the lottery pot ${figure(POT)} · ${figure(BONDS)} in bonds`
  const opinion = `_Opinion:_ ${say(secureRand, COPY.opinion, {})}`
  const text = [`*${NAME}* · ${masthead}`, ...stories.map((item) => `*${item.head}*\n${item.body}`), opinion].join("\n\n")
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: NAME } },
    { type: "context", elements: [{ type: "mrkdwn", text: masthead }] },
    ...stories.map((item) => section(`*${item.head}*\n${item.body}`)),
    { type: "divider" },
    { type: "context", elements: [{ type: "mrkdwn", text: opinion }, { type: "mrkdwn", text: glance }] },
  ]
  const posted = await ledger.call("chat.postMessage", { channel, text, blocks, unfurl_links: false }).then(
    () => true,
    (error: unknown) => (console.error("the paper didn't go out", error), false),
  )
  if (posted) ledger.setMeta("paper_no", edition)
  return posted
}
