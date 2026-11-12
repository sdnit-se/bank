// Shops: things with a price on them. The bank's own shop is run by admins and paid to the central bank, so spending
// there funds the bonds, the lottery top-up and the next stimulus. Everyone else can open a shop of their own, sell
// whatever they like (a code review, a lunch pick, cookies on Friday) and keep what it makes.
//
// Bank only takes the coins, tells the seller and says so in public; handing the thing over is up to a human.
// `/bank shop`, `/bank shop 3`, `/bank shop @someone`, `/bank shop sell 10 a code review`, and the Shop tab on the web.

import { CENTRAL, CENTS, type Listing } from "../shared/types"
import { brokeLine, say, secureRand, type Line } from "./games"
import { button, loud, newsroom, quiet, section, tooFast, type Ledger, type Message } from "./ledger"
import { money } from "./money"
import { levy, taxed } from "./taxes"

type Row = { id: number; seller: string; name: string; about: string; price: number; stock: number | null; sold: number; at: number }

/** The most anyone keeps on their shelves at once, and the most a slash command lists. */
const MOST = 20
const SHOWN = 15

const BOUGHT: Line[] = [
  (w) => `${w.user} bought *${w.item}* from ${w.seller} for ${w.price}. over to ${w.maker} to make it happen.`,
  (w) => `${w.user} spent ${w.price} on *${w.item}* from ${w.seller}. the first recorded use of this currency for anything.`,
  (w) => `${w.user} is now the owner of *${w.item}*, and ${w.price} poorer. ${w.seller} offers no refunds, obviously.`,
]

export function setupShop(sql: SqlStorage) {
  sql.exec(`create table if not exists listings (
    id integer primary key autoincrement, seller text not null, name text not null, about text not null default '',
    price integer not null, stock integer, sold integer not null default 0, at integer not null
  )`)
  // The bank's shop used to live in the settings. Its shelves move here once, in the same order, so `/bank shop 2`
  // still buys the second thing.
  if (sql.exec("select 1 from meta where key = 'listings'").toArray().length) return
  const saved = sql.exec<{ value: string }>("select value from meta where key = 'config'").toArray()[0]
  const config = saved ? (JSON.parse(saved.value) as { shop?: { name: string; price: number }[] }) : {}
  for (const item of config.shop ?? []) {
    sql.exec("insert into listings (seller, name, price, at) values (?, ?, ?, ?)", CENTRAL, item.name, Math.round(item.price * CENTS), Date.now())
  }
  sql.exec("insert into meta (key, value) values ('listings', 'true')")
}

const rows = (ledger: Ledger, where = "1 = 1", ...values: (string | number)[]) =>
  ledger.sql.exec<Row>(`select * from listings where ${where} order by seller = '${CENTRAL}' desc, seller, id`, ...values).toArray()

const find = (ledger: Ledger, id: number) => ledger.sql.exec<Row>("select * from listings where id = ?", id).toArray()[0] ?? null

const soldOut = (row: Row) => row.stock !== null && row.stock <= 0

/** Who is selling, as a name. Never a mention: a list of shops shouldn't ping everyone in it. */
const sellerName = (ledger: Ledger, seller: string) => (seller === CENTRAL ? "the bank" : (ledger.row(seller)?.name ?? "someone"))

/** Words someone typed, made safe for Slack and the canvas: no formatting, mentions or links. */
const plain = (text: string, most: number) =>
  String(text ?? "")
    .replace(/[<>&*_~`|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, most)

/** What the web app shows: every shelf, with prices in coins and who is behind each. */
export function shopFor(ledger: Ledger): { listings: Listing[]; people: Record<string, { name: string; image: string | null }> } {
  const listings = rows(ledger).filter((row) => row.seller === CENTRAL || !ledger.row(row.seller)?.gone)
  const people: Record<string, { name: string; image: string | null }> = {}
  for (const row of listings) {
    const image = ledger.sql.exec<{ image: string | null }>("select image from accounts where id = ?", row.seller).toArray()[0]?.image ?? null
    people[row.seller] = { name: sellerName(ledger, row.seller), image: row.seller === CENTRAL ? null : image }
  }
  return {
    listings: listings.map((row) => ({ id: row.id, seller: row.seller, name: row.name, about: row.about, price: row.price / CENTS, stock: row.stock, sold: row.sold })),
    people,
  }
}

/**
 * Puts something on a shelf, or changes it. People run their own shop; admins also run the bank's. Prices come in
 * coins. Returns the reason it can't be done, if it can't.
 */
export function stock(
  ledger: Ledger,
  user: string,
  input: { id?: number | null; bank?: boolean; name: string; about?: string; price: number; stock?: number | null },
): string | null {
  const existing = input.id ? find(ledger, input.id) : null
  if (input.id && !existing) return "that isn't for sale anymore."
  const seller = existing?.seller ?? (input.bank ? CENTRAL : user)
  if (seller === CENTRAL ? !ledger.admin(user) : seller !== user) return "that isn't your shop."
  const name = plain(input.name, 60)
  if (!name) return "say what it is."
  const price = Math.round(Number(input.price) * CENTS)
  if (!Number.isSafeInteger(price) || price < 1 || price > 1_000_000 * CENTS) return "the price has to be more than nothing and at most 1,000,000."
  const count = input.stock === null || input.stock === undefined || String(input.stock) === "" ? null : Math.floor(Number(input.stock))
  if (count !== null && !(count >= 0 && count <= 10_000)) return "how many you have has to be between 0 and 10,000, or left empty for no limit."
  const about = plain(input.about ?? "", 200)
  if (existing) {
    ledger.sql.exec("update listings set name = ?, about = ?, price = ?, stock = ? where id = ?", name, about, price, count, existing.id)
    return null
  }
  const shelf = ledger.sql.exec<{ n: number }>("select count(*) as n from listings where seller = ?", seller).one().n
  if (shelf >= MOST) return `a shop holds ${MOST} things at most. take something down first.`
  ledger.sql.exec("insert into listings (seller, name, about, price, stock, at) values (?, ?, ?, ?, ?, ?)", seller, name, about, price, count, Date.now())
  return null
}

/** Takes something off a shelf. Returns the reason it can't, if it can't. */
export function unstock(ledger: Ledger, user: string, id: number): string | null {
  const row = find(ledger, id)
  if (!row) return "that isn't for sale anymore."
  if (row.seller === CENTRAL ? !ledger.admin(user) : row.seller !== user) return "that isn't your shop."
  ledger.sql.exec("delete from listings where id = ?", id)
  return null
}

/**
 * Sells one. The coins go to the seller, or to the central bank for the bank's own things, and the seller is told
 * directly. `via` says where the buyer is: a Slack channel gets the news there, the web gets it in the bank's channel.
 */
export async function buy(ledger: Ledger, user: string, id: number, via: "slack" | "web"): Promise<Message> {
  const config = ledger.config()
  const row = find(ledger, id)
  if (!row) return quiet("that isn't for sale anymore. `/bank shop` shows what is.")
  if (soldOut(row)) return quiet(`*${row.name}* is sold out.`)
  if (row.seller === user) return quiet("that's your own shop. buying from yourself is called moving money around, and it's frowned upon.")
  if (row.seller !== CENTRAL && ledger.row(row.seller)?.gone) return quiet("whoever was selling that has left, so it can't be bought.")
  const buyer = (await ledger.ensure([user])).get(user)
  if (!buyer || buyer.gone) return quiet("only members of this workspace get to shop here.")
  if (buyer.balance < row.price) return quiet(brokeLine(secureRand, { balance: money(config, buyer.balance) }))
  if (tooFast(ledger, user, ["shop"], 3)) return quiet("slow down. it's a shop, not a slot machine.")
  if (!ledger.move({ from: user, to: row.seller, amount: row.price, kind: "shop", note: row.name, actor: user }).ok) return quiet("something went wrong, try again")
  ledger.sql.exec("update listings set sold = sold + 1, stock = case when stock is null then null else stock - 1 end where id = ?", row.id)
  // A sale between colleagues is a transfer like any other, and pays the same tax.
  const tax = row.seller === CENTRAL ? 0 : levy(ledger, { from: row.seller, amount: row.price, rate: config.taxes.transfer, note: "transfer tax", actor: user })
  const price = money(config, row.price)
  if (row.seller !== CENTRAL) {
    const left = row.stock === null ? "" : row.stock - 1 > 0 ? ` ${row.stock - 1} left.` : " that was the last one."
    await ledger
      .call("chat.postMessage", { channel: row.seller, text: `:shopping_bags: <@${user}> bought *${row.name}* from your shop for ${price}.${left} over to you.${taxed(config, tax)}`, unfurl_links: false })
      .catch((error: unknown) => console.error("shop notice failed", error))
  }
  const seller = sellerName(ledger, row.seller)
  const maker = row.seller === CENTRAL ? "an admin" : seller
  if (via === "web") {
    // Nobody asked to be woken up by someone else's shopping: the bank's channel gets names, not mentions.
    const home = newsroom(ledger)
    const text = `:shopping_bags: ${say(secureRand, BOUGHT, { user: buyer.name, item: row.name, price, seller, maker })}`
    if (home) await ledger.call("chat.postMessage", { channel: home, text, unfurl_links: false }).catch(() => undefined)
    return quiet(`you bought ${row.name} for ${price}.`)
  }
  return loud(`:shopping_bags: ${say(secureRand, BOUGHT, { user: `<@${user}>`, item: row.name, price, seller, maker })}`)
}

/** The shop's part of `/bank help`. */
export function shopHelp(ledger: Ledger) {
  const forSale = ledger.sql.exec<{ n: number }>("select count(*) as n from listings where stock is null or stock > 0").one().n
  return [`*shop* · \`/bank shop\` lists what coins can buy${forSale ? ` (${forSale} things)` : ""} · \`/bank shop sell 10 a code review\` opens your own`]
}

function shelves(ledger: Ledger, user: string, list: Row[], title: string): Message {
  const config = ledger.config()
  const open = list.filter((row) => !soldOut(row) && (row.seller === CENTRAL || !ledger.row(row.seller)?.gone))
  if (!open.length) return quiet(`${title}\nnothing for sale. \`/bank shop sell 10 a code review\` puts something up.`)
  const shown = open.slice(0, SHOWN)
  const line = (row: Row) =>
    `#${row.id} *${row.name}* · ${money(config, row.price)} · ${sellerName(ledger, row.seller)}${row.stock === null ? "" : ` · ${row.stock} left`}${row.about ? `\n${row.about}` : ""}`
  const more = open.length > shown.length ? `${open.length - shown.length} more at <${ledger.env.PUBLIC_URL}|the bank>` : ""
  const usage = "`/bank shop 3` buys #3 · `/bank shop sell 10 a code review` opens your own"
  return {
    ...quiet([title, ...shown.map(line), more, usage].filter(Boolean).join("\n")),
    blocks: [
      section(title),
      ...shown.map((row) => section(line(row), row.seller === user ? undefined : button("Buy", "shop_buy", String(row.id)))),
      ...(more ? [section(more)] : []),
      section(usage),
    ],
  }
}

/**
 * `/bank shop` lists what's for sale, `/bank shop 3` buys #3, `/bank shop @someone` shows their shop, `/bank shop
 * mine` yours, `/bank shop sell 10 a code review` puts something up and `/bank shop remove 3` takes it down.
 */
export async function shop(ledger: Ledger, input: { sub: string; words: string[]; user: string }): Promise<Message | null> {
  if (input.sub !== "shop") return null
  const config = ledger.config()
  const [first, ...rest] = input.words
  const balance = `you have ${money(config, ledger.row(input.user)?.balance ?? 0)}`
  if (!first) return shelves(ledger, input.user, rows(ledger), `*the shop* · ${balance}`)
  if (/^\d+$/.test(first)) return buy(ledger, input.user, Number(first), "slack")
  const mention = first.match(/^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/)
  if (mention) return shelves(ledger, input.user, rows(ledger, "seller = ?", mention[1]!), `*${sellerName(ledger, mention[1]!)}'s shop* · ${balance}`)
  if (first === "mine") return shelves(ledger, input.user, rows(ledger, "seller = ?", input.user), `*your shop*`)
  if (first === "sell") {
    const price = Number(rest[0]?.replace(",", "."))
    const problem = Number.isFinite(price) ? stock(ledger, input.user, { name: rest.slice(1).join(" "), price }) : "say the price first: `/bank shop sell 10 a code review`"
    if (problem) return quiet(problem)
    return quiet(`it's on your shelf. \`/bank shop mine\` shows your shop, and <${ledger.env.PUBLIC_URL}|the bank> lets you add a description or a limit.`)
  }
  if (first === "remove") {
    const problem = unstock(ledger, input.user, Number(rest[0]))
    return quiet(problem ?? "taken down.")
  }
  return quiet("`/bank shop` lists what's for sale, `/bank shop 3` buys #3, and `/bank shop sell 10 a code review` opens your own.")
}

/** A click on Buy. Null when the click wasn't the shop's. */
export async function shopClick(ledger: Ledger, input: { user: string; action: string; value: string }): Promise<Message | null> {
  if (input.action !== "shop_buy") return null
  // Buttons posted before shops had numbers carry the name of something the bank sold.
  const id = /^\d+$/.test(input.value) ? Number(input.value) : (rows(ledger, "seller = ? and name = ?", CENTRAL, input.value)[0]?.id ?? 0)
  return buy(ledger, input.user, id, "slack")
}
