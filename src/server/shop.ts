// The shop: things an admin has put a price on. `/bank shop`.
//
// What is paid goes to the central bank, so spending is what funds the bonds, the lottery top-up and the next
// stimulus. Bank only takes the coins and says so where everyone can see; handing the thing over is up to a human.

import { CENTRAL, type Config, type ShopItem } from "../shared/types"
import { brokeLine, say, secureRand, type Line } from "./games"
import { button, loud, quiet, section, tooFast, type Ledger, type Message } from "./ledger"
import { money } from "./money"

const BOUGHT: Line[] = [
  (w) => `${w.user} bought *${w.item}* for ${w.price}. somebody with authority has to make that happen now.`,
  (w) => `${w.user} spent ${w.price} on *${w.item}*. the first recorded use of this currency for anything.`,
  (w) => `${w.user} is now the owner of *${w.item}*, and ${w.price} poorer. no refunds, obviously.`,
]

/** The shop's part of `/bank help`: nothing at all while the shelves are empty. */
export function shopHelp(config: Config) {
  return config.shop.length ? [`*shop* · \`/bank shop\` · ${config.shop.length === 1 ? "one thing" : `${config.shop.length} things`} your coins can actually buy`] : []
}

async function buy(ledger: Ledger, user: string, item: ShopItem | undefined): Promise<Message> {
  const config = ledger.config()
  if (!item) return quiet("the shop doesn't sell that anymore. `/bank shop` shows what it has.")
  const row = (await ledger.ensure([user])).get(user)
  if (!row || row.gone) return quiet("only members of this workspace get to shop here.")
  if (row.balance < item.price) return quiet(brokeLine(secureRand, { balance: money(config, row.balance) }))
  if (tooFast(ledger, user, ["shop"], 3)) return quiet("slow down. it's a shop, not a slot machine.")
  if (!ledger.move({ from: user, to: CENTRAL, amount: item.price, kind: "shop", note: item.name, actor: user }).ok) return quiet("something went wrong, try again")
  return loud(`:shopping_bags: ${say(secureRand, BOUGHT, { user: `<@${user}>`, item: item.name, price: money(config, item.price) })}`)
}

/** Answers `/bank shop` with the shelves, and `/bank shop 2` by selling the second thing on them. Null for any other word. */
export async function shop(ledger: Ledger, input: { sub: string; words: string[]; user: string }): Promise<Message | null> {
  if (input.sub !== "shop") return null
  const config = ledger.config()
  if (!config.shop.length) return quiet(`the shop is empty. an admin can stock it at <${ledger.env.PUBLIC_URL}|the bank>.`)
  if (input.words[0]) return buy(ledger, input.user, config.shop[Number(input.words[0]) - 1])
  const title = `*the shop* · you have ${money(config, ledger.row(input.user)?.balance ?? 0)}`
  const lines = config.shop.map((item, index) => `${index + 1}. *${item.name}* · ${money(config, item.price)}`)
  return {
    ...quiet([title, ...lines, "`/bank shop 1` buys the first one"].join("\n")),
    blocks: [section(title), ...config.shop.map((item) => section(`*${item.name}*\n${money(config, item.price)}`, button("Buy", "shop_buy", item.name)))],
  }
}

/** A click on Buy. Null when the click wasn't the shop's. */
export async function shopClick(ledger: Ledger, input: { user: string; action: string; value: string }): Promise<Message | null> {
  if (input.action !== "shop_buy") return null
  return buy(ledger, input.user, ledger.config().shop.find((item) => item.name === input.value))
}
