// Bounties: coins put up for getting something done, paid to whoever did it.
// `/bank bounty 30 fix the flaky e2e test`
//
// The coins sit with the bounty board until whoever posted it says who did the job, and anyone can chip in on top.
// What is paid out counts as given by people, the same as a thank-you, because it is one. A bounty nobody has paid
// after thirty days is called off and everyone gets back what they put in.

import { BOUNTIES, CENTS, toCents } from "../shared/types"
import { brokeLine, secureRand } from "./games"
import { button, defused, inPlace, loud, quiet, settledCard, tooFast, withButtons, type Button, type Ledger, type Menu, type Message } from "./ledger"
import { money } from "./money"
import { levy, taxed } from "./taxes"

const OPEN_FOR = 30 * 24 * 60 * 60 * 1000
const MOST_OPEN = 5
const CHIP = 5 * CENTS
const USAGE = "say what it pays and what needs doing: `/bank bounty 30 fix the flaky e2e test`"

type Bounty = { id: number; by_id: string; task: string; claims: string; channel: string | null; at: number }

const find = (ledger: Ledger, id: number) => ledger.sql.exec<Bounty>("select * from bounties where id = ?", id).toArray()[0] ?? null
const funds = (ledger: Ledger, id: number) =>
  ledger.sql.exec<{ user_id: string; amount: number }>("select user_id, amount from bounty_funds where bounty = ? order by amount desc, user_id", id).toArray()
const claimsOf = (bounty: Bounty) => JSON.parse(bounty.claims) as string[]
const list = (ids: string[]) => ids.map((id) => `<@${id}>`).join(", ")

/** Every bounty on the board, with what it pays in cents, oldest first. */
export function openBounties(ledger: Ledger) {
  return ledger.sql
    .exec<{ id: number; task: string; pot: number }>("select id, task, (select sum(amount) from bounty_funds where bounty = bounties.id) as pot from bounties order by id")
    .toArray()
}

/** The bounties' part of `/bank help`. */
export function bountyHelp() {
  return [
    "*bounties* · coins for getting something done",
    "`/bank bounty 30 fix the flaky e2e test` · put 30 up for it. you pay whoever did it, and anyone can chip in",
    "`/bank bounties` · what's on the board",
  ]
}

/** The bounty as everyone sees it: the job, what it pays and from whom, who says they did it, and the buttons. */
function card(ledger: Ledger, bounty: Bounty): Message {
  const coins = (cents: number) => money(ledger.config(), cents)
  const all = funds(ledger, bounty.id)
  const backers = all.map((fund) => fund.user_id).filter((id) => id !== bounty.by_id)
  const claims = claimsOf(bounty)
  const text = [
    `:dart: *${bounty.task}*`,
    `*${coins(all.reduce((sum, fund) => sum + fund.amount, 0))}* from <@${bounty.by_id}>${backers.length ? ` and ${list(backers)}` : ""}`,
    claims.length ? `done, according to ${list(claims)}` : "nobody has claimed it yet",
    `bounty #${bounty.id} · <@${bounty.by_id}> pays whoever did it${claims.length ? "" : `, or calls it off with \`/bank bounty ${bounty.id} off\``}`,
  ].join("\n")
  const option = (label: string, value: string) => ({ text: { type: "plain_text", text: label.slice(0, 75) }, value })
  const buttons: (Button | Menu)[] = [button("I did it", "bounty_claim", String(bounty.id), "primary"), button(`Chip in ${coins(CHIP)}`, "bounty_chip", String(bounty.id))]
  // Slack wants at least two choices in a menu, so it appears once there is somebody to pay.
  if (claims.length) {
    const options = [...claims.slice(0, 4).map((id) => option(`Pay ${ledger.row(id)?.name ?? id}`, `${bounty.id}:pay:${id}`)), option("Call it off", `${bounty.id}:off`)]
    buttons.push({ type: "overflow", action_id: "bounty_rule", options })
  }
  return withButtons(loud(text), buttons)
}

async function post(ledger: Ledger, input: { user: string; channel: string | null; amount: number; task: string }): Promise<Message> {
  const config = ledger.config()
  if (input.amount < CENTS || input.task.length < 3) return quiet(USAGE)
  const mine = ledger.sql.exec<{ n: number }>("select count(*) as n from bounties where by_id = ?", input.user).one().n
  if (mine >= MOST_OPEN) return quiet(`you already have ${MOST_OPEN} bounties up. pay one out first: \`/bank bounties\``)
  const row = (await ledger.ensure([input.user])).get(input.user)
  if (!row || row.gone) return quiet("only members of this workspace can post bounties.")
  if (row.balance < input.amount) return quiet(brokeLine(secureRand, { balance: money(config, row.balance) }))
  if (tooFast(ledger, input.user, ["bounty"])) return quiet("slow down. the work isn't going anywhere, sadly.")
  if (!ledger.move({ from: input.user, to: BOUNTIES, amount: input.amount, kind: "bounty", note: input.task, actor: input.user }).ok) return quiet("something went wrong, try again")
  ledger.sql.exec("insert into bounties (by_id, task, claims, channel, at) values (?, ?, '[]', ?, ?)", input.user, input.task, input.channel, Date.now())
  const id = ledger.sql.exec<{ id: number }>("select max(id) as id from bounties where by_id = ?", input.user).one().id
  ledger.sql.exec("insert into bounty_funds (bounty, user_id, amount) values (?, ?, ?)", id, input.user, input.amount)
  return card(ledger, find(ledger, id)!)
}

async function chip(ledger: Ledger, user: string, id: number, amount: number): Promise<Message> {
  const config = ledger.config()
  const row = (await ledger.ensure([user])).get(user)
  if (!row || row.gone) return quiet("only members of this workspace can chip in.")
  const bounty = find(ledger, id)
  if (!bounty) return quiet("that bounty is closed.")
  if (amount < 1) return quiet(`say how much: \`/bank bounty ${id} chip 10\``)
  if (row.balance < amount) return quiet(brokeLine(secureRand, { balance: money(config, row.balance) }))
  if (tooFast(ledger, user, ["bounty"])) return quiet("slow down. generosity has a rate limit too.")
  if (!ledger.move({ from: user, to: BOUNTIES, amount, kind: "bounty", note: bounty.task, actor: user }).ok) return quiet("something went wrong, try again")
  ledger.sql.exec(
    "insert into bounty_funds (bounty, user_id, amount) values (?, ?, ?) on conflict (bounty, user_id) do update set amount = amount + excluded.amount",
    id,
    user,
    amount,
  )
  return card(ledger, bounty)
}

async function claim(ledger: Ledger, user: string, id: number): Promise<Message> {
  const row = (await ledger.ensure([user])).get(user)
  if (!row || row.gone || row.bot) return quiet("only members of this workspace can claim bounties.")
  const bounty = find(ledger, id)
  if (!bounty) return quiet("that bounty is closed.")
  if (bounty.by_id === user) return quiet("you can't claim your own bounty. pay someone, that's the whole idea.")
  const claims = claimsOf(bounty)
  if (claims.includes(user)) return quiet(`noted already. <@${bounty.by_id}> decides who gets paid.`)
  bounty.claims = JSON.stringify([...claims, user])
  ledger.sql.exec("update bounties set claims = ? where id = ?", bounty.claims, id)
  return card(ledger, bounty)
}

/** Takes a bounty off the board. Whoever removes it is the one who gets to pay it out or refund it. */
function close(ledger: Ledger, user: string, id: number) {
  const bounty = find(ledger, id)
  if (!bounty) return { problem: quiet("that bounty is closed.") }
  if (bounty.by_id !== user && !ledger.admin(user)) return { problem: quiet(`only <@${bounty.by_id}> or an admin can do that.`) }
  const all = funds(ledger, id)
  if (ledger.sql.exec("delete from bounties where id = ?", id).rowsWritten !== 1) return { problem: quiet("that bounty is closed.") }
  ledger.sql.exec("delete from bounty_funds where bounty = ?", id)
  return { bounty, all }
}

function refund(ledger: Ledger, all: { user_id: string; amount: number }[]) {
  for (const fund of all) ledger.move({ from: BOUNTIES, to: fund.user_id, amount: fund.amount, kind: "bounty", note: "refund" })
}

async function pay(ledger: Ledger, user: string, id: number, to: string): Promise<Message> {
  const config = ledger.config()
  const hunter = (await ledger.ensure([to])).get(to)
  if (!hunter || hunter.bot || hunter.gone) return quiet("they can't be paid. pick someone who works here.")
  if (find(ledger, id)?.by_id === to) return quiet("you can't pay your own bounty to yourself. nice try.")
  const closed = close(ledger, user, id)
  if (closed.problem) return closed.problem
  const { bounty, all } = closed
  const pot = all.reduce((sum, fund) => sum + fund.amount, 0)
  ledger.move({ from: BOUNTIES, to, amount: pot, kind: "give", note: bounty.task, actor: user })
  const tax = levy(ledger, { from: to, amount: pot, rate: config.taxes.transfer, note: "transfer tax", actor: user })
  const backers = all.map((fund) => fund.user_id).filter((id) => id !== bounty.by_id)
  return loud(`:dart: <@${to}> collected *${money(config, pot)}* for *${bounty.task}*, from <@${bounty.by_id}>${backers.length ? ` and ${list(backers)}` : ""}.${taxed(config, tax)}`)
}

function callOff(ledger: Ledger, user: string, id: number): Message {
  const closed = close(ledger, user, id)
  if (closed.problem) return closed.problem
  refund(ledger, closed.all)
  return loud(`:dart: ~${closed.bounty.task}~ is called off. everyone got back what they put in.`)
}

/** Calls off every bounty that has been up too long. Returns their tasks, for the morning paper. */
export function expireBounties(ledger: Ledger, now = Date.now()) {
  const old = ledger.sql.exec<Bounty>("select * from bounties where at < ?", now - OPEN_FOR).toArray()
  for (const bounty of old) {
    refund(ledger, funds(ledger, bounty.id))
    ledger.sql.exec("delete from bounty_funds where bounty = ?", bounty.id)
    ledger.sql.exec("delete from bounties where id = ?", bounty.id)
  }
  return old.map((bounty) => bounty.task)
}

const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/

/** `/bank bounty` and `/bank bounties`. Null when the words aren't about bounties. */
export async function bounties(ledger: Ledger, input: { sub: string; words: string[]; user: string; channel: string | null }): Promise<Message | null> {
  if (input.sub !== "bounty" && input.sub !== "bounties") return null
  const coins = (cents: number) => money(ledger.config(), cents)
  const [first, second, third] = input.words.map((word) => word.toLowerCase())
  if (first === undefined) {
    const all = openBounties(ledger)
    const lines = all.map((bounty) => `#${bounty.id} · *${bounty.task}* · ${coins(bounty.pot)} · \`/bank bounty ${bounty.id}\``)
    return quiet([`*the bounty board* · ${all.length ? `${all.length} open` : "empty"}`, ...lines, USAGE].join("\n"))
  }
  const known = /^\d+$/.test(first) ? find(ledger, Number(first)) : null
  if (known && second === undefined) return { ...card(ledger, known), response_type: "ephemeral" }
  if (known && (second === "claim" || second === "done")) return claim(ledger, input.user, known.id)
  if (known && second === "off") return callOff(ledger, input.user, known.id)
  if (known && second === "chip") return chip(ledger, input.user, known.id, third ? (toCents(third) ?? 0) : CHIP)
  if (known && second === "pay") {
    const to = input.words.slice(2).join(" ").match(MENTION)?.[1]
    return to ? pay(ledger, input.user, known.id, to) : quiet(`say who: \`/bank bounty ${known.id} pay @someone\``)
  }
  const amount = toCents(first)
  if (amount === null) return quiet(USAGE)
  return post(ledger, { user: input.user, channel: input.channel, amount, task: defused(input.words.slice(1).join(" ")).slice(0, 200) })
}

/** A click under a bounty. Null when the click wasn't a bounty's. */
export async function bountyClick(ledger: Ledger, input: { user: string; action: string; value: string }): Promise<Message | null> {
  if (!input.action.startsWith("bounty_")) return null
  if (input.action === "bounty_claim" || input.action === "bounty_chip") {
    const id = Number(input.value) || 0
    const answer = await (input.action === "bounty_claim" ? claim(ledger, input.user, id) : chip(ledger, input.user, id, CHIP))
    return answer.response_type === "ephemeral" ? answer : inPlace(answer)
  }
  const [id, move, to] = input.value.split(":") as [string, string, string | undefined]
  const before = find(ledger, Number(id))
  const answer = move === "pay" && to ? await pay(ledger, input.user, Number(id), to) : callOff(ledger, input.user, Number(id))
  return settledCard(ledger, before?.channel ?? null, answer, `:dart: ~${before?.task ?? "bounty"}~`)
}
