// The Home tab: what someone sees when they open Bank in Slack. It is drawn again each time they open it, from the
// same tables the commands read, so there is nothing to keep in step. Read-only: everything it shows has a command.

import { POT } from "../shared/types"
import { bonded } from "./bonds"
import { openBounties } from "./bounties"
import { drawTime } from "./casino"
import { button, held, section, type Block, type Ledger } from "./ledger"
import { money } from "./money"
import { openPools } from "./pools"
import { sources } from "./stats"
import { titlesOf, TITLES } from "./titles"

const context = (text: string): Block => ({ type: "context", elements: [{ type: "mrkdwn", text }] })

export async function publishHome(ledger: Ledger, user: string) {
  const row = (await ledger.ensure([user])).get(user)
  if (!row || row.gone || row.bot) return
  const config = ledger.config()
  const coins = (cents: number) => money(config, cents)
  const signed = (cents: number) => `${cents < 0 ? "−" : "+"}${coins(Math.abs(cents)).split(" ")[0]}`

  const from = sources(ledger, user)
  const locked = bonded(ledger, user)
  const where = [
    `${coins(row.received)} given to you by people`,
    from.casino && `casino ${signed(from.casino)}`,
    from.market && `market ${signed(from.market)}`,
    locked && `${coins(locked)} locked in bonds`,
  ].filter(Boolean)
  const blocks: Block[] = [
    section(`You have *${coins(row.balance)}* :${config.symbol}:`, { ...button("Open the bank", "home_open", "open"), url: ledger.env.PUBLIC_URL }),
    context(where.join(" · ")),
  ]
  const part = (title: string, lines: string[], empty: string) => blocks.push({ type: "divider" }, section([`*${title}*`, ...(lines.length ? lines : [empty])].join("\n")))

  const mine = titlesOf(ledger)[user] ?? []
  part(`Your titles · ${mine.length} of ${TITLES.length}`, mine.length ? [mine.slice(0, 8).join(" · ")] : [], "None yet. `/bank titles` shows what there is to earn.")

  const board = openBounties(ledger).slice(0, 8)
  part("Bounties", board.map((bounty) => `• *${bounty.task}* · ${coins(bounty.pot)} · \`/bank bounty ${bounty.id}\``), "Nothing on the board. `/bank bounty 30 fix the flaky e2e test` puts something there.")

  if (config.games.enabled) {
    const stakes = new Map(
      ledger.sql.exec<{ pool: number; side: string; amount: number }>("select pool, side, amount from pool_bets where user_id = ?", user).toArray().map((bet) => [bet.pool, bet]),
    )
    const pools = openPools(ledger).slice(0, 8)
    part(
      "Office bets",
      pools.map((pool) => {
        const bet = stakes.get(pool.id)
        return `• *${pool.question}* · ${bet ? `you have ${coins(bet.amount)} on ${bet.side}` : `\`/bank pool ${pool.id}\``}`
      }),
      "None open. `/bank pool will the demo work?` starts one.",
    )
    const tickets = ledger.sql.exec<{ mine: number | null; sold: number | null }>("select sum(case when id = ? then count end) as mine, sum(count) as sold from tickets", user).one()
    part(
      "Lottery",
      [
        tickets.sold
          ? `The pot is ${coins(held(ledger, POT))}, and you hold ${tickets.mine ?? 0} of the ${tickets.sold} tickets. Drawn ${drawTime()}.`
          : `Nobody has a ticket for the draw ${drawTime()} yet. \`/bank lottery 5\` buys five.`,
      ],
      "",
    )
  }

  const bonds = ledger.sql.exec<{ amount: number; rate: number; matures: number }>("select amount, rate, matures from bonds where user_id = ? order by matures", user).toArray()
  if (bonds.length) part("Your bonds", bonds.map((bond) => `• ${coins(bond.amount)} at ${bond.rate}% · back <!date^${Math.floor(bond.matures / 1000)}^{date_short_pretty}|in a week>`), "")

  if (config.shop.length) {
    part("Shop", config.shop.map((item, index) => `${index + 1}. *${item.name}* · ${coins(item.price)}${row.balance < item.price ? "" : ` · \`/bank shop ${index + 1}\``}`), "")
  }

  blocks.push({ type: "divider" }, context("`/bank help` lists everything"))
  await ledger.call("views.publish", { user_id: user, view: { type: "home", blocks } })
}
