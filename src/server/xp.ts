// Experience and levels: something that only ever goes up, for the things here that take skill or kindness and not
// a stake. Cracking the vault, typing a race, a game of connect four or rock paper scissors, thanking a colleague and
// being thanked. `/bank level`.
//
// Each of those earns a little, up to a most a day, so nobody levels by doing one thing a thousand times or by
// passing a coin back and forth. Nothing counts from before the day this was added. A new level pays a small raise in
// newly made coins, and is said once: on the answer the person was getting anyway, and in the next morning's paper.
// Nobody is messaged about it and nobody is mentioned.

import { levelAt, levelOf, nextDraw, rankOf, type Me } from "../shared/types"
import { quiet, type Ledger, type Message } from "./ledger"
import { money } from "./money"

const DAY = 24 * 60 * 60_000

/** What earns experience, and the most each can earn someone in a day. */
const SOURCES = {
  vault: { label: "The vault", most: 100 },
  race: { label: "Typing race", most: 150 },
  match: { label: "Connect four, rock paper scissors", most: 100 },
  gave: { label: "Thanking people", most: 50 },
  thanked: { label: "Being thanked", most: 75 },
}
type Source = keyof typeof SOURCES
type Up = { user_id: string; name: string; level: number }

export function setupXp(sql: SqlStorage) {
  // A new level is a row of its own that earns nothing: `source` is "level" and `about` is which.
  sql.exec("create table if not exists xp (id integer primary key autoincrement, user_id text not null, source text not null, amount integer not null, about text, at integer not null)")
}

const sum = (ledger: Ledger, where: string, ...params: unknown[]) => ledger.sql.exec<{ n: number | null }>(`select sum(amount) as n from xp where ${where}`, ...params).one().n ?? 0
const morning = () => nextDraw(Date.now()) - DAY

export const xpOf = (ledger: Ledger, user: string) => sum(ledger, "user_id = ?", user)
/** What one thing has earned someone since the morning round. */
export const xpToday = (ledger: Ledger, user: string, source: Source) => sum(ledger, "user_id = ? and source = ? and at > ?", user, source, morning())

/** Everyone's experience by their id, for the leaderboard. */
export function xpOfAll(ledger: Ledger) {
  return Object.fromEntries(ledger.sql.exec<{ user_id: string; n: number }>("select user_id, sum(amount) as n from xp group by user_id").toArray().map((row) => [row.user_id, row.n]))
}

/** Where someone stands, for the web: their experience and how much of today's each thing has given. */
export function standing(ledger: Ledger, user: string): Pick<Me, "xp" | "earning"> {
  const sources = Object.entries(SOURCES) as [Source, (typeof SOURCES)[Source]][]
  return { xp: xpOf(ledger, user), earning: sources.map(([source, { label, most }]) => ({ source, label, most, today: xpToday(ledger, user, source) })) }
}

/**
 * Gives someone experience and returns how much of it counted, which is none once the day's share from that source
 * is used up. `about` makes it once a day: the first thanks to each colleague counts, the tenth to the same one
 * doesn't. Whatever levels it takes them past are paid for here.
 */
export function gain(ledger: Ledger, user: string, source: Source, amount: number, about: string | null = null) {
  const person = ledger.row(user)
  if (!person || person.bot || person.gone) return 0
  if (about && ledger.sql.exec("select 1 from xp where user_id = ? and source = ? and about = ? and at > ?", user, source, about, morning()).toArray().length) return 0
  const got = Math.min(Math.round(amount), SOURCES[source].most - xpToday(ledger, user, source))
  if (!(got > 0)) return 0
  const before = xpOf(ledger, user)
  ledger.sql.exec("insert into xp (user_id, source, amount, about, at) values (?, ?, ?, ?, ?)", user, source, got, about, Date.now())
  const raise = ledger.config().raise
  for (let level = levelOf(before) + 1; level <= levelOf(before + got); level++) {
    ledger.sql.exec("insert into xp (user_id, source, amount, about, at) values (?, 'level', 0, ?, ?)", user, String(level), Date.now())
    // Made, not moved, like a wage.
    if (raise > 0) ledger.move({ from: null, to: user, amount: raise, kind: "level", note: `level ${level}`, actor: user })
  }
  return got
}

/** The newest row there is, to ask later what has happened since. */
export const xpMark = (ledger: Ledger) => ledger.sql.exec<{ n: number | null }>("select max(id) as n from xp").one().n ?? 0

/** Who has gone up since a row or a moment, and to what: the highest level each reached, highest first. */
function ups(ledger: Ledger, by: "id" | "at", since: number) {
  return ledger.sql
    .exec<Up>(
      `select xp.user_id, accounts.name, max(cast(about as integer)) as level from xp join accounts on accounts.id = xp.user_id
       where source = 'level' and xp.${by} > ? group by xp.user_id order by level desc, accounts.name`,
      since,
    )
    .toArray()
}

/** Yesterday's new levels, for the morning paper. Names, never mentions. */
export const levelNews = (ledger: Ledger, since: number) => ups(ledger, "at", since)

/** "level 3, Teller" when the level comes with a new rank, and "level 4" when it doesn't. */
export const levelName = (level: number) => (level > 1 && rankOf(level) !== rankOf(level - 1) ? `level ${level}, ${rankOf(level)}` : `level ${level}`)

/**
 * The same answer with a line under it for anyone it took up a level, by name. A private answer only says so about
 * whoever it is for. This is the only way Slack hears of a level as it happens: no message is sent for it.
 */
export function levelled(ledger: Ledger, message: Message, mark: number, user: string): Message {
  const raise = ledger.config().raise
  const lines = ups(ledger, "id", mark)
    .filter((up) => message.response_type !== "ephemeral" || up.user_id === user)
    .map((up) => `:arrow_up: ${up.name} reached *${levelName(up.level)}*${raise > 0 ? ` · +${money(ledger.config(), raise)}` : ""}`)
  if (!lines.length) return message
  const note = lines.join("\n")
  return { ...message, text: `${message.text}\n${note}`, ...(message.blocks ? { blocks: [...message.blocks, { type: "context", elements: [{ type: "mrkdwn", text: note }] }] } : {}) }
}

/** Answers `/bank level`, or returns null when the word isn't about it. */
export function levels(ledger: Ledger, input: { sub: string; user: string }): Message | null {
  if (!["level", "levels", "xp", "rank"].includes(input.sub)) return null
  const { xp, earning } = standing(ledger, input.user)
  const level = levelOf(xp)
  const [from, next] = [levelAt(level), levelAt(level + 1)]
  const filled = Math.floor(((xp - from) / (next - from)) * 12)
  const raise = ledger.config().raise
  return quiet(
    [
      `*level ${level}, ${rankOf(level)}* · ${xp.toLocaleString("en-GB")} xp, ${(next - xp).toLocaleString("en-GB")} to go to level ${level + 1}${raise > 0 ? `, which pays ${money(ledger.config(), raise)}` : ""}`,
      `\`${"█".repeat(filled)}${"░".repeat(12 - filled)}\``,
      `today · ${earning.map((item) => `${item.label.toLowerCase()} ${item.today}/${item.most}`).join(" · ")}`,
    ].join("\n"),
  )
}

/** Its part of `/bank help`. */
export const levelHelp = () => ["*levels* · `/bank level` · the vault, typing races, connect four, rock paper scissors and thanking people earn experience, win or lose, and it never goes down"]
