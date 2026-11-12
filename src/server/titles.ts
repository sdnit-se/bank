// Titles: what people have earned by what the ledger says they did. `/bank titles`.
//
// Nothing is counted for them as it happens. Each title is one question asked of the ledger in the daily round, and
// whoever newly answers to it is named in the morning paper. On the first round of a month, three more go to whoever
// was thanked most, won most and lost most in the month before. A title is kept for good once it is earned.

import { BONDS, BOUNTIES, CENTS, HOUSE, POOLS, POT } from "../shared/types"
import { quiet, type Ledger, type Message } from "./ledger"

const coins = (amount: number) => amount * CENTS

/** `who` selects the ids of everyone who has earned it. */
export const TITLES: { name: string; how: string; who: string }[] = [
  { name: "Pillar of the community", how: "be thanked with 250 by colleagues", who: `select id from accounts where received >= ${coins(250)}` },
  { name: "High roller", how: "stake 1,000 in all", who: `select from_id as id from entries where kind = 'bet' group by from_id having sum(amount) >= ${coins(1000)}` },
  { name: "Regular", how: "place 100 bets", who: "select from_id as id from entries where kind = 'bet' group by from_id having count(*) >= 100" },
  {
    name: "Whale",
    how: "come out 100 or more ahead on a single bet",
    // A payout includes the stake, so what it came to is the payout less the stake on the same game just before it.
    who: `select p.to_id as id from entries p where p.kind = 'payout' and p.from_id = '${HOUSE}' and p.amount - (select b.amount from entries b
      where b.kind = 'bet' and b.to_id = '${HOUSE}' and b.from_id = p.to_id and b.note = p.note and b.id < p.id order by b.id desc limit 1) >= ${coins(100)}`,
  },
  { name: "Rock bottom", how: "gamble your way down to nothing", who: "select id from accounts where balance = 0 and gone = 0 and id in (select from_id from entries where kind = 'bet')" },
  { name: "Lottery winner", how: "win the daily draw", who: `select to_id as id from entries where kind = 'payout' and from_id = '${POT}'` },
  { name: "Duellist", how: "win 10 duels", who: "select to_id as id from entries where kind = 'duel' group by to_id having count(*) >= 10" },
  { name: "Punching bag", how: "lose 10 duels", who: "select from_id as id from entries where kind = 'duel' group by from_id having count(*) >= 10" },
  { name: "Master criminal", how: "rob the house 3 times", who: "select to_id as id from entries where kind = 'payout' and note = 'heist' group by to_id having count(*) >= 3" },
  { name: "Oracle", how: "win 5 office bets", who: `select to_id as id from entries where kind = 'payout' and from_id = '${POOLS}' and note = 'the office pool' group by to_id having count(*) >= 5` },
  { name: "Bond villain", how: "lend the central bank 500 in all", who: `select from_id as id from entries where kind = 'bond' and to_id = '${BONDS}' group by from_id having sum(amount) >= ${coins(500)}` },
  { name: "Day trader", how: "make 25 trades", who: "select actor as id from entries where kind in ('buy', 'sell') group by actor having count(*) >= 25" },
  { name: "Model taxpayer", how: "pay 100 in tax", who: `select from_id as id from entries where kind = 'tax' group by from_id having sum(amount) >= ${coins(100)}` },
  { name: "Bounty hunter", how: "collect 3 bounties", who: `select to_id as id from entries where kind = 'give' and from_id = '${BOUNTIES}' group by to_id having count(*) >= 3` },
  { name: "Big spender", how: "spend 200 in the shop", who: `select from_id as id from entries where kind = 'shop' group by from_id having sum(amount) >= ${coins(200)}` },
]

/** What someone won or lost at the casino between two moments, one row per win and per stake. */
const NET = `select to_id as id, amount as net from entries where kind in ('payout', 'duel') and at >= ?1 and at < ?2
  union all select from_id, -amount from entries where kind in ('bet', 'duel') and at >= ?1 and at < ?2`

/** One winner each, for the month between `?1` and `?2`. */
const CROWNS: { name: string; who: string }[] = [
  { name: "Colleague of", who: "select to_id as id from entries where kind in ('give', 'reaction') and at >= ?1 and at < ?2 group by to_id order by sum(amount) desc limit 1" },
  { name: "Luckiest of", who: `select id from (${NET}) group by id having sum(net) > 0 order by sum(net) desc limit 1` },
  { name: "Greater fool of", who: `select id from (${NET}) group by id having sum(net) < 0 order by sum(net) limit 1` },
]

/** Gives a title to everyone `who` selects that doesn't have it. `from` and `to` are the month a crown is for. */
const give = (ledger: Ledger, title: string, who: string, now: number, from = 0, to = 0) =>
  ledger.sql.exec(`insert or ignore into titles (user_id, title, at) select id, ?3, ?4 from (${who}) where id in (select id from accounts where bot = 0)`, from, to, title, now)

/** Hands out whatever has been earned since the last round. Returns the new ones, for the morning paper. */
export function award(ledger: Ledger, now = Date.now()) {
  const before = ledger.sql.exec<{ n: number | null }>("select max(rowid) as n from titles").one().n ?? 0
  for (const title of TITLES) give(ledger, title.name, title.who, now)
  const month = new Date(now).toISOString().slice(0, 7)
  if (ledger.meta<string>("crowned") !== month) {
    ledger.setMeta("crowned", month)
    const [year, index] = [Number(month.slice(0, 4)), Number(month.slice(5)) - 1]
    const [from, to] = [Date.UTC(year, index - 1, 1), Date.UTC(year, index, 1)]
    const label = new Date(from).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
    for (const crown of CROWNS) give(ledger, `${crown.name} ${label}`, crown.who, now, from, to)
  }
  return ledger.sql.exec<{ user_id: string; title: string }>("select user_id, title from titles where rowid > ? order by rowid", before).toArray()
}

/** Everyone's titles by their id, newest first, for the leaderboard. */
export function titlesOf(ledger: Ledger) {
  const all: Record<string, string[]> = {}
  for (const row of ledger.sql.exec<{ user_id: string; title: string }>("select user_id, title from titles order by at desc, rowid desc").toArray()) {
    ;(all[row.user_id] ??= []).push(row.title)
  }
  return all
}

/** Answers `/bank titles` with what you have and what is left to earn. Null for any other word. */
export function titles(ledger: Ledger, input: { sub: string; user: string }): Message | null {
  if (input.sub !== "titles" && input.sub !== "title") return null
  const mine = titlesOf(ledger)[input.user] ?? []
  const crowns = mine.filter((title) => !TITLES.some((known) => known.name === title))
  return quiet(
    [
      `*your titles* · ${mine.length} earned`,
      ...crowns.map((title) => `:crown: *${title}*`),
      ...TITLES.map((title) => (mine.includes(title.name) ? `:white_check_mark: *${title.name}*` : `:white_circle: ${title.name} · ${title.how}`)),
      "the first round of each month also crowns whoever was thanked most, won most and lost most the month before.",
    ].join("\n"),
  )
}
