// What the Workspace lends everything this fork adds (the casino, the market, taxes, the shop, the stats): its tables,
// its one way of moving coins, and Slack. Keeping those features behind this keeps workspace.ts close to upstream.
//
// Amounts are in cents, like the rest of the ledger.

import { BONDS, nextDraw, type Config, type EntryKind } from "../shared/types"
import type { Env } from "./env"
import type { Rand } from "./games"

type Row = { id: string; name: string; balance: number; bot: number; gone: number }

type Moved =
  | { ok: true; id: number; from: number | null; to: number | null }
  | { ok: false; reason: "insufficient" | "unknown"; balance: number }

export type Ledger = {
  sql: SqlStorage
  storage: DurableObjectStorage
  env: Env
  config(): Config
  row(id: string): Row | null
  ensure(ids: string[]): Promise<Map<string, Row | null>>
  move(input: { from: string | null; to: string | null; amount: number; kind: EntryKind; note?: string | null; actor?: string | null }): Moved
  meta<T>(key: string): T | null
  setMeta(key: string, value: unknown): void
  call<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>
  /** Whether this person runs the bank. */
  admin(id: string): boolean
  /** Decides how the games come out. Only tests set it; everything else gets real randomness. */
  rand?: Rand
}

export const held = (ledger: Ledger, id: string) => ledger.row(id)?.balance ?? 0

/** Whether someone has already made `most` moves of these kinds in the last minute. */
export function tooFast(ledger: Ledger, user: string, kinds: EntryKind[], most = 10) {
  const recent = ledger.sql
    .exec<{ n: number }>(`select count(*) as n from entries where actor = ? and at > ? and kind in (${kinds.map((kind) => `'${kind}'`).join(", ")})`, user, Date.now() - 60_000)
    .one().n
  return recent >= most
}

/** Where the bank announces things: the channel an admin picked, or until they have, wherever a lottery ticket was last bought. */
export const newsroom = (ledger: Ledger) => ledger.config().channel || ledger.meta<string>("lottery_channel")

/** The daily round draws the lottery, settles the house, taxes wealth and pays back bonds. This makes sure one is coming. */
export async function schedule(ledger: Ledger) {
  const next = nextDraw(Date.now())
  if ((await ledger.storage.getAlarm()) !== next) await ledger.storage.setAlarm(next)
}

/** How one of this fork's entries reads in `/bank history`, or null when the entry is one of upstream's. */
export function historyLine(row: { kind: string; from_id: string | null; to_id: string | null; note: string | null }, user: string, amount: string) {
  switch (row.kind) {
    case "bet":
      return `-${amount} on ${row.note === "lottery" ? "lottery tickets" : (row.note ?? "a bet")}`
    case "payout":
      if (row.note === "pool refund") return `+${amount} back from an office bet that was called off`
      return `+${amount} won at ${row.note === "lottery" ? "the lottery" : (row.note ?? "the casino")}`
    case "duel":
      return row.from_id === user ? `-${amount} lost a duel to <@${row.to_id}>` : `+${amount} won a duel against <@${row.from_id}>`
    case "stimulus":
      return `+${amount} from the central bank${row.note === "bond interest" ? ", interest on a bond" : ""}`
    case "buy":
      return `-${amount} into ${row.note ?? "the market"}`
    case "sell":
      return `+${amount} from selling ${row.note ?? "a position"}`
    case "tax":
      return row.from_id === user ? `-${amount} ${row.note ?? "tax"}` : null
    case "bond":
      return row.to_id === BONDS ? `-${amount} into a bond at ${row.note}` : `+${amount} back from a bond`
    case "shop":
      return `-${amount} at the shop for ${row.note}`
    default:
      return null
  }
}

// ---------- what a command answers with

type Text = { type: string; text: string }
export type Button = { type: "button"; text: Text; action_id: string; value: string; style?: "primary" | "danger" }
/** A "more" menu. What was picked arrives the way a button's value does. */
export type Menu = { type: "overflow"; action_id: string; options: { text: Text; value: string }[] }
export type Block =
  | { type: "section"; text: Text; accessory?: Button }
  | { type: "actions"; elements: (Button | Menu)[] }
  | { type: "header"; text: Text }
  | { type: "context"; elements: Text[] }
  | { type: "divider" }

export type Message = {
  response_type: "ephemeral" | "in_channel"
  text: string
  blocks?: Block[]
  /** For an answer to a button: put this in place of the message the button was under. */
  replace_original?: boolean
}

/** An answer only the person who asked can see. */
export const quiet = (text: string): Message => ({ response_type: "ephemeral", text })
/** An answer for the whole channel. */
export const loud = (text: string): Message => ({ response_type: "in_channel", text })

export const section = (text: string, accessory?: Button): Block => ({ type: "section", text: { type: "mrkdwn", text }, ...(accessory ? { accessory } : {}) })

export const button = (text: string, action: string, value: string, style?: Button["style"]): Button => ({
  type: "button",
  text: { type: "plain_text", text },
  action_id: action,
  value,
  ...(style ? { style } : {}),
})

/** The same message with buttons under it. The text stays as it is for anything that can't show them. */
export function withButtons(message: Message, buttons: (Button | Menu)[]): Message {
  return { ...message, blocks: [section(message.text), { type: "actions", elements: buttons }] }
}

/** Puts a message where the one with the buttons was. It carries its own block so the buttons are sure to go. */
export function inPlace(message: Message): Message {
  return { ...message, blocks: message.blocks ?? [section(message.text)], replace_original: true }
}
