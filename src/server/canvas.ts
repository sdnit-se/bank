// The front page: a canvas in the bank's channel showing where things stand right now. The morning paper says what
// happened; this says what's open, who's ahead and what's on the board. It is written from scratch every time, from
// the same tables the commands read, after anything public happens and at the daily round.
//
// Bank only ever edits the canvas it made itself. A channel that already has someone else's canvas is left alone,
// and the admin page says why.

import { BOUNTIES, CENTRAL, HOUSE, POT } from "../shared/types"
import { openBounties } from "./bounties"
import { held, type Ledger } from "./ledger"
import { money } from "./money"
import { openPools } from "./pools"

type Placed = { channel: string; id: string }

const when = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Stockholm", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })

/** What the admin page says when Slack refused, by Slack's error code. */
const REFUSED: Record<string, string> = {
  channel_canvas_already_exists: "That channel already has a canvas, and Bank won't overwrite someone else's. Remove it from the channel, or pick another one.",
  missing_scope: "Bank needs permission to write canvases: paste slack-manifest.json into the app's settings again and reinstall it.",
  team_tier_cannot_create_channel_canvases: "This Slack plan doesn't let apps add a canvas to a channel.",
  free_team_canvas_tab_already_exists: "This Slack plan allows one canvas per channel, and that channel has one.",
  canvas_disabled_user_team: "Canvases are switched off for this workspace.",
}

/** Slack text as canvas markdown: mentions in the canvas's own syntax, and nothing that breaks a table. */
const cell = (text: string) => text.replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, "![](@$1)").replace(/<#(C[A-Z0-9]+)(?:\|[^>]*)?>/g, "![](#$1)").replace(/\|/g, "\\|")

function page(ledger: Ledger) {
  const config = ledger.config()
  const coins = (cents: number) => money(config, cents)
  const who = (id: string) => `![](@${id})`
  const table = (head: string[], rows: string[][]) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n")
  const out = [`*Where things stand, ${when.format(Date.now())}. The full picture is at ${ledger.env.PUBLIC_URL}*`]

  const people = ledger.sql
    .exec<{ id: string; received: number; balance: number }>("select id, received, balance from accounts where bot = 0 and gone = 0 and received > 0 order by received desc, balance desc limit 10")
    .toArray()
  out.push("## :trophy: Most appreciated")
  out.push(people.length ? table(["#", "Who", "Given by people", "Holds"], people.map((row, index) => [String(index + 1), who(row.id), coins(row.received), coins(row.balance)])) : "Nobody has been thanked yet.")

  const board = openBounties(ledger)
  out.push("## :dart: Bounty board")
  out.push(
    board.length
      ? `${table(["#", "Job", "Pays"], board.slice(0, 20).map((bounty) => [`#${bounty.id}`, cell(bounty.task), coins(bounty.pot)]))}\n\n\`/bank bounty ${board[0]!.id}\` shows that one, with a button to claim it.`
      : "Nothing on the board. `/bank bounty 30 fix the flaky e2e test` puts something there.",
  )

  if (config.games.enabled) {
    const sides = new Map(
      ledger.sql
        .exec<{ pool: number; yes: number; no: number }>("select pool, sum(case when side = 'yes' then amount else 0 end) as yes, sum(case when side = 'no' then amount else 0 end) as no from pool_bets group by pool")
        .toArray()
        .map((row) => [row.pool, row]),
    )
    const pools = openPools(ledger)
    out.push("## :crystal_ball: Office bets")
    out.push(
      pools.length
        ? table(["#", "Question", "Yes", "No"], pools.slice(0, 20).map((pool) => [`#${pool.id}`, cell(pool.question), coins(sides.get(pool.id)?.yes ?? 0), coins(sides.get(pool.id)?.no ?? 0)]))
        : "None open. `/bank pool will the demo work?` starts one.",
    )
    const sold = ledger.sql.exec<{ n: number | null }>("select sum(count) as n from tickets").one().n ?? 0
    out.push("## :tickets: Lottery")
    out.push(`The pot is **${coins(held(ledger, POT))}** across ${sold} ${sold === 1 ? "ticket" : "tickets"}, drawn at 09:00. \`/bank lottery 5\` buys five.`)
  }

  out.push("## :classical_building: Central bank")
  const rate = config.taxes.interest
  out.push(
    [
      rate > 0 ? `Bonds pay **${rate}% a week** (\`/bank bond 50\`).` : "No bonds on sale.",
      `It holds ${coins(held(ledger, CENTRAL))} and the house ${coins(held(ledger, HOUSE))}. Another ${coins(held(ledger, BOUNTIES))} sits on the bounty board.`,
    ].join(" "),
  )

  if (config.shop.length) {
    out.push("## :shopping_bags: Shop")
    out.push(table(["#", "What", "Price"], config.shop.map((item, index) => [String(index + 1), cell(item.name), coins(item.price)])))
  }
  return out.join("\n\n")
}

const codeOf = (error: unknown) => (error as { code?: string }).code ?? ""
const refused = (code: string) => REFUSED[code] ?? `Slack wouldn't take the canvas (${code || "no reason given"}).`

/** Writes the front page, making it first if need be. Returns why it couldn't, or null. */
async function write(ledger: Ledger): Promise<string | null> {
  const channel = ledger.config().channel
  if (!channel) return null
  const placed = ledger.meta<Placed>("canvas")
  const content = { type: "markdown", markdown: page(ledger) }
  if (placed?.channel === channel) {
    try {
      await ledger.call("canvases.edit", { canvas_id: placed.id, changes: [{ operation: "replace", document_content: content }] })
      return null
    } catch (error) {
      // Somebody deleted it, so it is made again below. Anything else is passing, or worth telling the admin about.
      const code = codeOf(error)
      if (code !== "canvas_not_found") return REFUSED[code] ?? (console.error("front page failed", code), null)
    }
  } else if (placed) {
    // The bank moved to another channel: take the old page down rather than leave it going stale.
    await ledger.call("canvases.delete", { canvas_id: placed.id }).catch(() => null)
  }
  ledger.setMeta("canvas", null)
  try {
    const made = await ledger.call<{ canvas_id: string }>("conversations.canvases.create", { channel_id: channel, title: "Bank", document_content: content })
    ledger.setMeta("canvas", { channel, id: made.canvas_id } satisfies Placed)
    return null
  } catch (error) {
    return refused(codeOf(error))
  }
}

// One write at a time per workspace. Anything that happens during a write asks for one more, so the page always ends
// up showing the latest state, however many things happen at once.
const writing = new WeakMap<object, { again: boolean }>()

/** Brings the front page up to date. Safe to call as often as anything changes. */
export async function refreshFrontPage(ledger: Ledger) {
  const busy = writing.get(ledger.storage)
  if (busy) return void (busy.again = true)
  const state = { again: true }
  writing.set(ledger.storage, state)
  try {
    while (state.again) {
      state.again = false
      ledger.setMeta("canvas_problem", await write(ledger).catch((error: unknown) => (console.error("front page failed", error), null)))
    }
  } finally {
    writing.delete(ledger.storage)
  }
}
