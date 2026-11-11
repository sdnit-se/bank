// The morning paper: one post after the daily round instead of an announcement for every little thing. It reads the
// last day off the ledger and reports it the way the pink pages would, if the pink pages covered forty people losing
// play money. Wording only: no coins move here. A day with nothing to report gets no paper.

import { BONDS, CENTRAL, HOUSE, POOLS, POT } from "../shared/types"
import type { matureBonds } from "./bonds"
import { say, secureRand, type Line } from "./games"
import { held, section, type Block, type Ledger } from "./ledger"
import { money } from "./money"

const NAME = "THE FINANCIAL CRIMES"
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
    (w) => `${w.winner} wins ${w.pot} in daily draw; colleagues "thrilled", sources lie\nHolding ${w.share} tickets, ${w.winner} beat the field in what analysts called "a textbook case of someone else winning". The pot reopens at zero. Hope remains fully priced in.`,
    (w) => `Lottery pays ${w.pot} to ${w.winner} in blow to everyone else\nPeople familiar with the matter confirmed that ${w.winner}, holding ${w.share} tickets, "did nothing to deserve it". Ticket sales are expected to recover by lunchtime.`,
    (w) => `${w.winner} lands ${w.pot} windfall, pledges to stay humble, fails by 09:05\nWith ${w.share} tickets the odds were against it, as they will be again today for everyone now buying more.`,
  ],
  robbed: [
    (w) => `Masked crew robs house of ${w.amount}; police "aware of the Slack channel"\nThe house confirmed the loss and said its security budget "was also in the vault".`,
    (w) => `House robbed of ${w.amount} in broad daylight, on a public channel, with buttons\nInvestigators have a list of suspects, a signed confession from each, and no plans to do anything.`,
  ],
  foiled: [
    (w) => `Heist foiled: crew loses ${w.amount}, dignity\nThe getaway driver has asked not to be named. The house thanked the crew for the deposit.`,
    (w) => `Attempted robbery nets house ${w.amount}\nA spokesman for the house called the heist "our most reliable revenue line this quarter" and encouraged the crew to try again.`,
  ],
  houseUp: [
    (w) => `House posts ${w.amount} profit as gamblers continue to gamble`,
    (w) => `House up ${w.amount} on strong fundamentals of human nature`,
    (w) => `Casino revenue beats forecasts by ${w.amount}; forecasts were zero`,
  ],
  houseDown: [
    (w) => `House loses ${w.amount} in worst session since the last one`,
    (w) => `House down ${w.amount}; management blames luck, a factor it normally welcomes`,
  ],
  loser: [
    (w) => `${w.who} led the decline, down ${w.amount}, and described the position as "long-term".`,
    (w) => `${w.who} gave up ${w.amount} and is understood to be "due".`,
    (w) => `${w.who} lost ${w.amount} and told reporters the strategy "works on paper".`,
  ],
  winner: [
    (w) => `${w.who} finished up ${w.amount} and is expected to return it by Friday.`,
    (w) => `${w.who} took ${w.amount} off the table, a gain regulators are calling "transitory".`,
  ],
  thanks: [
    (w) => `${w.amount} paid for actual work\n${w.sent} sent, and ${w.who} was thanked most, with ${w.most}. Unlike everything else on this page, somebody did something.`,
    (w) => `Real economy grows by ${w.amount}\n${w.sent} sent. ${w.who} received the most, ${w.most}, for work colleagues described as "actually useful". Markets did not react, having no idea what that means.`,
  ],
  defaulted: [
    (w) => `Central bank in "technical" default on bond interest\n${w.lent} came back to ${w.owners} with ${w.paid} of the interest promised. The governor called it "a liquidity event, not a solvency event" and left by a side door.`,
  ],
  matured: [
    (w) => `Bonds mature: ${w.paid} in interest paid for doing nothing\n${w.owners} got ${w.lent} back with interest. Patience was rewarded, which several gamblers described as "disgusting".`,
  ],
  lent: [
    (w) => `Savers lend central bank ${w.amount}\nThe coins are locked away for a week, out of reach of blackjack and the wealth tax. Demand was described as "cowardly but rational".`,
    (w) => `Flight to safety: ${w.amount} moves into bonds\nAnalysts said the buyers "appear to have met the casino". The central bank welcomed the confidence and declined to say what it would do with the money.`,
  ],
  wealth: [
    (w) => `Wealth tax raises ${w.amount} from ${w.payers}\nThe rich called the levy "confiscatory" and are said to be considering Monaco, or bonds. Everyone else called it "a start".`,
  ],
  called: [(w) => `Office bet settles: ${w.who} ${w.collect} ${w.amount}\nThe losers have been told that being wrong in public builds character.`],
  asked: [(w) => `New on the book: "${w.question}"\n${w.open} Take a side before someone finds out the answer.`],
  expired: [(w) => `"${w.question}" called off after thirty days of nobody knowing\nAll stakes were returned. The question joins the long list of things this office never found out.`],
  trades: [
    (w) => `${w.trades} worth ${w.amount} cross the desk\nNo trader could explain their thesis when asked. Past performance is no guide to future performance, but it is a guide to these people.`,
    (w) => `Equities: ${w.trades}, ${w.amount}, no plan\nOne investor said they were "in it for the long term", by which they meant until it goes down.`,
  ],
  bought: [(w) => `${w.first}\n${w.rest}Economists welcomed fresh evidence that the currency can be exchanged for goods.`],
  opinion: [
    () => `"I've run the numbers and red is due", by a man who has run no numbers`,
    () => `"Why I'm long on slots", by someone with no coins`,
    () => `"The house always wins, and that's good for workers", by the house`,
    () => `"Bonds are for cowards", by a man who has lost everything twice this week`,
    () => `"My portfolio is down 40% and I have never felt more alive"`,
    () => `"We asked a lottery winner for advice and it was useless"`,
    () => `"Diversify", says a man holding one stock`,
    () => `"Deficits are a state of mind", by the central bank`,
    () => `Lunch with the FC: the central bank governor orders nothing and expenses it`,
    () => `"It was a coin flip", and other things people say after losing a coin flip`,
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

  const stories: { tag: string; head: string; body: string }[] = []
  const story = (tag: string, lines: Line[], words: Record<string, string>, more = "") => {
    const [head, ...rest] = say(secureRand, lines, words).split("\n")
    stories.push({ tag, head: head!, body: [...rest, more].filter(Boolean).join(" ") })
  }
  const count = (n: number, one: string, many: string) => (n === 1 ? `One ${one}` : `${n} ${many}`)

  if (round.lottery) story("LOTTERY", COPY.lottery, { winner: at(round.lottery.winner), pot: coins(round.lottery.pot), share: round.lottery.share }, round.lottery.tax ? `The taxman took ${coins(round.lottery.tax)}.` : "")
  if (day.crew) story("CRIME", day.robbed ? COPY.robbed : COPY.foiled, { amount: coins(Math.abs(day.robbed - day.crew)) })
  if (day.bets && best && worst) {
    const parts = [
      `${count(day.bets, "bet was", "bets were")} placed against the house.`,
      worst[1] < 0 ? say(secureRand, COPY.loser, { who: at(worst[0]), amount: coins(-worst[1]) }) : "",
      best[1] > 0 ? say(secureRand, COPY.winner, { who: at(best[0]), amount: coins(best[1]) }) : `Nobody finished ahead, which the house called "a return to normal".`,
      day.duels ? `${count(day.duels, "duel was", "duels were")} fought. All parties described the coin as "biased".` : "",
    ]
    story("MARKETS", house < 0 ? COPY.houseDown : house > 0 ? COPY.houseUp : [() => `Casino ends flat; nobody learns anything`], { amount: coins(Math.abs(house)) }, parts.filter(Boolean).join(" "))
  }
  if (top) {
    const total = [...thanked.values()].reduce((sum, amount) => sum + amount, 0)
    story("THE REAL ECONOMY", COPY.thanks, { amount: coins(total), sent: count(day.thanks, "thank-you was", "thank-yous were"), who: at(top[0]), most: coins(top[1]) })
  }
  if (round.matured) {
    const { owners, lent, paid, short } = round.matured
    story("GILTS", short ? COPY.defaulted : COPY.matured, { owners: names(owners), lent: coins(lent), paid: coins(paid) })
  } else if (day.lent) story("GILTS", COPY.lent, { amount: coins(day.lent) })
  if (round.wealth?.collected) story("TAX", COPY.wealth, { amount: coins(round.wealth.collected), payers: count(round.wealth.payers, "person", "people").toLowerCase() })
  if (callers.size) story("FUTURES", COPY.called, { who: names([...callers]), collect: callers.size === 1 ? "collects" : "collect", amount: coins(day.pooled) })
  if (asked.length) story("FUTURES", COPY.asked, { question: asked[0]!.question, open: asked.map((pool) => `Office bet #${pool.id} is open: \`/bank pool ${pool.id}\`.`).join(" ") })
  if (round.expired.length) story("FUTURES", COPY.expired, { question: round.expired[0]! })
  if (day.trades) story("EQUITIES", COPY.trades, { trades: count(day.trades, "trade", "trades"), amount: coins(day.traded) })
  if (bought.length) story("HOW TO SPEND IT", COPY.bought, { first: bought[0]!, rest: bought.slice(1, 6).map((line) => `${line}. `).join("") })
  if (round.honours.length) {
    const more = round.honours.length > 8 ? ` And ${round.honours.length - 8} more, all under \`/bank titles\`.` : ""
    stories.push({ tag: "HONOURS", head: "The honours list", body: round.honours.slice(0, 8).map((honour) => `${at(honour.user_id)} is now *${honour.title}*.`).join(" ") + more })
  }
  if (!stories.length) return false

  const edition = (ledger.meta<number>("paper_no") ?? 0) + 1
  const masthead = `${today.format(now)} · No. ${edition} · without fear, favour or coins`
  const supply = ledger.sql.exec<{ n: number }>("select sum(balance) as n from accounts").one().n
  const figure = (id: string) => coins(held(ledger, id)).split(" ")[0]
  const glance = `${coins(supply)} in existence · the house holds ${figure(HOUSE)} · the central bank ${figure(CENTRAL)} · the lottery pot ${figure(POT)} · ${figure(BONDS)} in bonds`
  const opinion = `_Opinion:_ ${say(secureRand, COPY.opinion, {})}`
  const text = [`*${NAME}* · ${masthead}`, ...stories.map((item) => `*${item.head}*\n${item.body}`), opinion].join("\n\n")
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: NAME } },
    { type: "context", elements: [{ type: "mrkdwn", text: masthead }] },
    ...stories.map((item) => section(`${item.tag}\n*${item.head}*\n${item.body}`)),
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
